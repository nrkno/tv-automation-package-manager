import _ from 'underscore'
import { PeripheralDeviceAPI } from '@sofie-automation/server-core-integration'
import { CoreHandler } from './coreHandler'
import {
	Accessor,
	AccessorOnPackage,
	ExpectedPackage,
	ExpectedPackageStatusAPI,
	PackageContainer,
	PackageContainerOnPackage,
} from '@sofie-automation/blueprints-integration'
import { generateExpectations, generatePackageContainerExpectations } from './expectationGenerator'
import { ExpectationManager, ExpectationManagerServerOptions } from '@shared/expectation-manager'
import {
	ClientConnectionOptions,
	Expectation,
	ExpectationManagerWorkerAgent,
	PackageManagerConfig,
	LoggerInstance,
	PackageContainerExpectation,
	literal,
} from '@shared/api'
import deepExtend from 'deep-extend'
import clone = require('fast-clone')

export class PackageManagerHandler {
	private _coreHandler!: CoreHandler
	private _observers: Array<any> = []

	private _expectationManager: ExpectationManager

	private expectedPackageCache: { [id: string]: ExpectedPackageWrap } = {}
	private packageContainersCache: PackageContainers = {}

	private reportedWorkStatuses: { [id: string]: ExpectedPackageStatusAPI.WorkStatus } = {}
	private toReportExpectationStatus: {
		[id: string]: {
			workStatus: ExpectedPackageStatusAPI.WorkStatus | null
			/** If the status is new and needs to be reported to Core */
			isUpdated: boolean
		}
	} = {}
	private sendUpdateExpectationStatusTimeouts: NodeJS.Timeout | undefined

	private reportedPackageStatuses: { [id: string]: ExpectedPackageStatusAPI.PackageContainerPackageStatus } = {}
	private toReportPackageStatus: {
		[key: string]: {
			containerId: string
			packageId: string
			packageStatus: ExpectedPackageStatusAPI.PackageContainerPackageStatus | null
			/** If the status is new and needs to be reported to Core */
			isUpdated: boolean
		}
	} = {}
	private sendUpdatePackageContainerPackageStatusTimeouts: NodeJS.Timeout | undefined

	private externalData: { packageContainers: PackageContainers; expectedPackages: ExpectedPackageWrap[] } = {
		packageContainers: {},
		expectedPackages: [],
	}
	private _triggerUpdatedExpectedPackagesTimeout: NodeJS.Timeout | null = null
	private monitoredPackages: {
		[monitorId: string]: ResultingExpectedPackage[]
	} = {}
	settings: PackageManagerSettings = {
		delayRemoval: 0,
	}

	constructor(
		public logger: LoggerInstance,
		private managerId: string,
		private serverOptions: ExpectationManagerServerOptions,
		private serverAccessUrl: string | undefined,
		private workForceConnectionOptions: ClientConnectionOptions
	) {
		this._expectationManager = new ExpectationManager(
			this.logger,
			this.managerId,
			this.serverOptions,
			this.serverAccessUrl,
			this.workForceConnectionOptions,
			(
				expectationId: string,
				expectaction: Expectation.Any | null,
				actualVersionHash: string | null,
				statusInfo: {
					status?: string
					progress?: number
					statusReason?: string
				}
			) => this.updateExpectationStatus(expectationId, expectaction, actualVersionHash, statusInfo),
			(
				containerId: string,
				packageId: string,
				packageStatus: ExpectedPackageStatusAPI.PackageContainerPackageStatus | null
			) => this.updatePackageContainerPackageStatus(containerId, packageId, packageStatus),
			(
				containerId: string,
				packageContainer: PackageContainerExpectation | null,
				statusInfo: {
					statusReason?: string
				}
			) => this.updatePackageContainerStatus(containerId, packageContainer, statusInfo),
			(message: ExpectationManagerWorkerAgent.MessageFromWorkerPayload.Any) => this.onMessageFromWorker(message)
		)
	}

	async init(_config: PackageManagerConfig, coreHandler: CoreHandler): Promise<void> {
		this._coreHandler = coreHandler

		this._coreHandler.setPackageManagerHandler(this)

		this.logger.info('PackageManagerHandler init')

		// const peripheralDevice = await coreHandler.core.getPeripheralDevice()
		// const settings: TSRSettings = peripheralDevice.settings || {}

		coreHandler.onConnected(() => {
			this.setupObservers()
			// this.resendStatuses()
		})
		this.setupObservers()
		this.onSettingsChanged()
		this._triggerUpdatedExpectedPackages()

		await this.cleanReportedExpectations()
		await this._expectationManager.init()

		this.logger.info('PackageManagerHandler initialized')
	}
	onSettingsChanged(): void {
		this.settings = {
			delayRemoval: this._coreHandler.delayRemoval,
		}
	}
	getExpectationManager(): ExpectationManager {
		return this._expectationManager
	}
	private wrapExpectedPackage(
		packageContainers: PackageContainers,
		expectedPackage: ExpectedPackage.Any
	): ExpectedPackageWrap | undefined {
		const combinedSources: PackageContainerOnPackage[] = []
		for (const packageSource of expectedPackage.sources) {
			const lookedUpSource: PackageContainer = packageContainers[packageSource.containerId]
			if (lookedUpSource) {
				// We're going to combine the accessor attributes set on the Package with the ones defined on the source:
				const combinedSource: PackageContainerOnPackage = {
					...omit(clone(lookedUpSource), 'accessors'),
					accessors: {},
					containerId: packageSource.containerId,
				}

				const accessorIds = _.uniq(
					Object.keys(lookedUpSource.accessors).concat(Object.keys(packageSource.accessors))
				)

				for (const accessorId of accessorIds) {
					const sourceAccessor = lookedUpSource.accessors[accessorId] as Accessor.Any | undefined

					const packageAccessor = packageSource.accessors[accessorId] as AccessorOnPackage.Any | undefined

					if (packageAccessor && sourceAccessor && packageAccessor.type === sourceAccessor.type) {
						combinedSource.accessors[accessorId] = deepExtend({}, sourceAccessor, packageAccessor)
					} else if (packageAccessor) {
						combinedSource.accessors[accessorId] = clone<AccessorOnPackage.Any>(packageAccessor)
					} else if (sourceAccessor) {
						combinedSource.accessors[accessorId] = clone<Accessor.Any>(
							sourceAccessor
						) as AccessorOnPackage.Any
					}
				}
				combinedSources.push(combinedSource)
			}
		}
		// Lookup Package targets:
		const combinedTargets: PackageContainerOnPackage[] = []

		for (const layer of expectedPackage.layers) {
			// Hack: we use the layer name as a 1-to-1 relation to a target containerId
			const packageContainerId: string = layer

			if (packageContainerId) {
				const lookedUpTarget = packageContainers[packageContainerId]
				if (lookedUpTarget) {
					// Todo: should the be any combination of properties here?
					combinedTargets.push({
						...omit(clone(lookedUpTarget), 'accessors'),
						accessors: lookedUpTarget.accessors as {
							[accessorId: string]: AccessorOnPackage.Any
						},
						containerId: packageContainerId,
					})
				}
			}
		}

		if (combinedSources.length) {
			if (combinedTargets.length) {
				return {
					expectedPackage: expectedPackage,
					priority: 999, // lowest priority
					sources: combinedSources,
					targets: combinedTargets,
					playoutDeviceId: '',
					external: true,
				}
			}
		}
		return undefined
	}
	setExternalData(packageContainers: PackageContainers, expectedPackages: ExpectedPackage.Any[]): void {
		const expectedPackagesWraps: ExpectedPackageWrap[] = []

		for (const expectedPackage of expectedPackages) {
			const wrap = this.wrapExpectedPackage(packageContainers, expectedPackage)
			if (wrap) {
				expectedPackagesWraps.push(wrap)
			}
		}

		this.externalData = {
			packageContainers: packageContainers,
			expectedPackages: expectedPackagesWraps,
		}
		this._triggerUpdatedExpectedPackages()
	}
	private setupObservers(): void {
		if (this._observers.length) {
			this.logger.debug('Clearing observers..')
			this._observers.forEach((obs) => {
				obs.stop()
			})
			this._observers = []
		}
		this.logger.info('Renewing observers')

		const expectedPackagesObserver = this._coreHandler.core.observe('deviceExpectedPackages')
		expectedPackagesObserver.added = () => {
			this._triggerUpdatedExpectedPackages()
		}
		expectedPackagesObserver.changed = () => {
			this._triggerUpdatedExpectedPackages()
		}
		expectedPackagesObserver.removed = () => {
			this._triggerUpdatedExpectedPackages()
		}
		this._observers.push(expectedPackagesObserver)
	}
	private _triggerUpdatedExpectedPackages() {
		this.logger.info('_triggerUpdatedExpectedPackages')

		if (this._triggerUpdatedExpectedPackagesTimeout) {
			clearTimeout(this._triggerUpdatedExpectedPackagesTimeout)
			this._triggerUpdatedExpectedPackagesTimeout = null
		}

		this._triggerUpdatedExpectedPackagesTimeout = setTimeout(() => {
			this._triggerUpdatedExpectedPackagesTimeout = null
			this.logger.info('_triggerUpdatedExpectedPackages inner')

			const expectedPackages: ExpectedPackageWrap[] = []
			const packageContainers: PackageContainers = {}

			const objs = this._coreHandler.core.getCollection('deviceExpectedPackages').find(() => true)

			const activePlaylistObj = objs.find((o) => o.type === 'active_playlist')
			if (!activePlaylistObj) {
				this.logger.warn(`Collection objects active_playlist not found`)
				this.logger.info(`objs in deviceExpectedPackages:`, objs)
				return
			}
			const activePlaylist = activePlaylistObj.activeplaylist as ActivePlaylist
			const activeRundowns = activePlaylistObj.activeRundowns as ActiveRundown[]

			// Add from external data:
			{
				for (const expectedPackage of this.externalData.expectedPackages) {
					expectedPackages.push(expectedPackage)
				}
				Object.assign(packageContainers, this.externalData.packageContainers)
			}

			// Add from Core collections:
			{
				const expectedPackageObjs = objs.filter((o) => o.type === 'expected_packages')

				if (!expectedPackageObjs.length) {
					this.logger.warn(`Collection objects expected_packages not found`)
					this.logger.info(`objs in deviceExpectedPackages:`, objs)
					return
				}
				for (const expectedPackageObj of expectedPackageObjs) {
					for (const expectedPackage of expectedPackageObj.expectedPackages) {
						// Note: There might be duplicates of packages here, to be deduplicated later
						expectedPackages.push(expectedPackage)
					}
				}

				const packageContainerObj = objs.find((o) => o.type === 'package_containers')
				if (!packageContainerObj) {
					this.logger.warn(`Collection objects package_containers not found`)
					this.logger.info(`objs in deviceExpectedPackages:`, objs)
					return
				}
				Object.assign(packageContainers, packageContainerObj.packageContainers as PackageContainers)
			}

			// Add from Monitors:
			{
				for (const monitorExpectedPackages of Object.values(this.monitoredPackages)) {
					for (const expectedPackage of monitorExpectedPackages) {
						expectedPackages.push(expectedPackage)
					}
				}
			}

			this.handleExpectedPackages(packageContainers, activePlaylist, activeRundowns, expectedPackages)
		}, 300)
	}

	private handleExpectedPackages(
		packageContainers: PackageContainers,
		activePlaylist: ActivePlaylist,
		activeRundowns: ActiveRundown[],

		expectedPackages: ExpectedPackageWrap[]
	) {
		// Step 0: Save local cache:
		this.expectedPackageCache = {}
		this.packageContainersCache = packageContainers
		for (const exp of expectedPackages) {
			// Note: There might be duplicates in expectedPackages

			const existing = this.expectedPackageCache[exp.expectedPackage._id]
			if (
				!existing ||
				existing.priority > exp.priority // If the existing priority is lower (ie higher), replace it
			) {
				this.expectedPackageCache[exp.expectedPackage._id] = exp
			}
		}

		this.logger.info(`Has ${expectedPackages.length} expectedPackages`)
		// this.logger.info(JSON.stringify(expectedPackages, null, 2))

		// Step 1: Generate expectations:
		const expectations = generateExpectations(
			this._expectationManager.managerId,
			this.packageContainersCache,
			activePlaylist,
			activeRundowns,
			expectedPackages,
			this.settings
		)
		this.logger.info(`Has ${Object.keys(expectations).length} expectations`)
		const packageContainerExpectations = generatePackageContainerExpectations(
			this._expectationManager.managerId,
			this.packageContainersCache,
			activePlaylist
		)
		this.logger.info(`Has ${Object.keys(packageContainerExpectations).length} packageContainerExpectations`)
		this.ensureMandatoryPackageContainerExpectations(packageContainerExpectations)
		// this.logger.info(JSON.stringify(expectations, null, 2))

		// Step 2: Track and handle new expectations:
		this._expectationManager.updatePackageContainerExpectations(packageContainerExpectations)

		this._expectationManager.updateExpectations(expectations)
	}
	public updateExpectationStatus(
		expectationId: string,
		expectaction: Expectation.Any | null,
		actualVersionHash: string | null,
		statusInfo: {
			status?: string
			progress?: number
			statusReason?: string
		}
	): void {
		if (!expectaction) {
			if (this.toReportExpectationStatus[expectationId]) {
				this.triggerSendUpdateExpectationStatus(expectationId, null)
			}
		} else {
			if (!expectaction.statusReport.sendReport) return // Don't report the status

			const workStatus: ExpectedPackageStatusAPI.WorkStatus = {
				// Default properties:
				...{
					status: 'N/A',
					progress: 0,
					statusReason: '',
				},
				// Previous properties:
				...(((this.toReportExpectationStatus[expectationId] || {}) as any) as Record<string, unknown>), // Intentionally cast to Any, to make typings in const packageStatus more strict
				// Updated porperties:
				...expectaction.statusReport,
				...statusInfo,

				fromPackages: expectaction.fromPackages.map((fromPackage) => {
					const prevPromPackage = this.toReportExpectationStatus[
						expectationId
					]?.workStatus?.fromPackages.find((p) => p.id === fromPackage.id)
					return {
						id: fromPackage.id,
						expectedContentVersionHash: fromPackage.expectedContentVersionHash,
						actualContentVersionHash: actualVersionHash || prevPromPackage?.actualContentVersionHash || '',
					}
				}),
			}

			this.triggerSendUpdateExpectationStatus(expectationId, workStatus)
		}
	}
	private triggerSendUpdateExpectationStatus(
		expectationId: string,
		workStatus: ExpectedPackageStatusAPI.WorkStatus | null
	) {
		this.toReportExpectationStatus[expectationId] = {
			workStatus: workStatus,
			isUpdated: true,
		}

		if (!this.sendUpdateExpectationStatusTimeouts) {
			this.sendUpdateExpectationStatusTimeouts = setTimeout(() => {
				delete this.sendUpdateExpectationStatusTimeouts
				this.sendUpdateExpectationStatus()
			}, 500)
		}
	}
	private sendUpdateExpectationStatus() {
		const changesTosend: UpdateExpectedPackageWorkStatusesChanges = []

		for (const [expectationId, o] of Object.entries(this.toReportExpectationStatus)) {
			if (o.isUpdated) {
				if (!o.workStatus) {
					if (this.reportedWorkStatuses[expectationId]) {
						// Removed
						changesTosend.push({
							id: expectationId,
							type: 'delete',
						})
						delete this.reportedWorkStatuses[expectationId]
					}
				} else {
					const lastReportedStatus = this.reportedWorkStatuses[expectationId]

					if (!lastReportedStatus) {
						// Inserted
						changesTosend.push({
							id: expectationId,
							type: 'insert',
							status: o.workStatus,
						})
					} else {
						// Updated
						const mod: Partial<ExpectedPackageStatusAPI.WorkStatus> = {}
						for (const key of Object.keys(o.workStatus) as (keyof ExpectedPackageStatusAPI.WorkStatus)[]) {
							if (o.workStatus[key] !== lastReportedStatus[key]) {
								mod[key] = o.workStatus[key] as any
							}
						}
						if (!_.isEmpty(mod)) {
							changesTosend.push({
								id: expectationId,
								type: 'update',
								status: mod,
							})
						}
					}
					this.reportedWorkStatuses[expectationId] = o.workStatus
				}

				o.isUpdated = false
			}
		}

		if (changesTosend.length) {
			this._coreHandler.core
				.callMethod(PeripheralDeviceAPI.methods.updateExpectedPackageWorkStatuses, [changesTosend])
				.catch((err) => {
					this.logger.error('Error when calling method updateExpectedPackageWorkStatuses:')
					this.logger.error(err)
				})
		}
	}
	private async cleanReportedExpectations() {
		// Clean out all reported statuses, this is an easy way to sync a clean state with core
		this.reportedWorkStatuses = {}
		await this._coreHandler.core.callMethod(
			PeripheralDeviceAPI.methods.removeAllExpectedPackageWorkStatusOfDevice,
			[]
		)
	}
	public updatePackageContainerPackageStatus(
		containerId: string,
		packageId: string,
		packageStatus: ExpectedPackageStatusAPI.PackageContainerPackageStatus | null
	): void {
		const packageContainerPackageId = `${containerId}_${packageId}`
		if (!packageStatus) {
			this.triggerSendUpdatePackageContainerPackageStatus(containerId, packageId, null)
		} else {
			const o: ExpectedPackageStatusAPI.PackageContainerPackageStatus = {
				// Default properties:
				...{
					status: ExpectedPackageStatusAPI.PackageContainerPackageStatusStatus.NOT_READY,
					progress: 0,
					statusReason: '',
				},
				// pre-existing properties:
				...(((this.toReportPackageStatus[packageContainerPackageId] || {}) as any) as Record<string, unknown>), // Intentionally cast to Any, to make typings in the outer spread-assignment more strict
				// Updated properties:
				...packageStatus,
			}

			this.triggerSendUpdatePackageContainerPackageStatus(containerId, packageId, o)
		}
	}
	private triggerSendUpdatePackageContainerPackageStatus(
		containerId: string,
		packageId: string,
		packageStatus: ExpectedPackageStatusAPI.PackageContainerPackageStatus | null
	): void {
		const key = `${containerId}_${packageId}`

		this.toReportPackageStatus[key] = {
			containerId,
			packageId,
			packageStatus,
			isUpdated: true,
		}

		if (!this.sendUpdatePackageContainerPackageStatusTimeouts) {
			this.sendUpdatePackageContainerPackageStatusTimeouts = setTimeout(() => {
				delete this.sendUpdatePackageContainerPackageStatusTimeouts
				this.sendUpdatePackageContainerPackageStatus()
			}, 300)
		}
	}
	public sendUpdatePackageContainerPackageStatus(): void {
		const changesTosend: UpdatePackageContainerPackageStatusesChanges = []

		for (const [key, o] of Object.entries(this.toReportPackageStatus)) {
			if (o.isUpdated) {
				if (!o.packageStatus) {
					if (this.reportedPackageStatuses[key]) {
						// Removed
						changesTosend.push({
							containerId: o.containerId,
							packageId: o.packageId,
							type: 'delete',
						})
						delete this.reportedPackageStatuses[key]
					}
				} else {
					// Inserted / Updated
					changesTosend.push({
						containerId: o.containerId,
						packageId: o.packageId,
						type: 'update',
						status: o.packageStatus,
					})
					this.reportedPackageStatuses[key] = o.packageStatus
				}

				o.isUpdated = false
			}
		}

		if (changesTosend.length) {
			this._coreHandler.core
				.callMethod(PeripheralDeviceAPI.methods.updatePackageContainerPackageStatuses, [changesTosend])
				.catch((err) => {
					this.logger.error('Error when calling method updatePackageContainerPackageStatuses:')
					this.logger.error(err)
				})
		}
	}
	public updatePackageContainerStatus(
		containerId: string,
		_packageContainer: PackageContainerExpectation | null,
		statusInfo: { statusReason?: string | undefined }
	): void {
		this.logger.info(`PackageContainerStatus "${containerId}"`)
		this.logger.info(statusInfo.statusReason || '>No reason<')
	}
	private async onMessageFromWorker(
		message: ExpectationManagerWorkerAgent.MessageFromWorkerPayload.Any
	): Promise<any> {
		switch (message.type) {
			case 'fetchPackageInfoMetadata':
				return this._coreHandler.core.callMethod(
					PeripheralDeviceAPI.methods.fetchPackageInfoMetadata,
					message.arguments
				)
			case 'updatePackageInfo':
				return this._coreHandler.core.callMethod(
					PeripheralDeviceAPI.methods.updatePackageInfo,
					message.arguments
				)
			case 'removePackageInfo':
				return this._coreHandler.core.callMethod(
					PeripheralDeviceAPI.methods.removePackageInfo,
					message.arguments
				)
			case 'reportFromMonitorPackages':
				this.reportMonitoredPackages(...message.arguments)
				break

			default:
				// @ts-expect-error message is never
				throw new Error(`Unsupported message type "${message.type}"`)
		}
	}
	public restartExpectation(workId: string): void {
		// This method can be called from core
		this._expectationManager.restartExpectation(workId)
	}
	public restartAllExpectations(): void {
		// This method can be called from core
		this._expectationManager.restartAllExpectations()
	}
	public abortExpectation(workId: string): void {
		// This method can be called from core
		this._expectationManager.abortExpectation(workId)
	}
	/** Ensures that the packageContainerExpectations containes the mandatory expectations */
	private ensureMandatoryPackageContainerExpectations(packageContainerExpectations: {
		[id: string]: PackageContainerExpectation
	}): void {
		for (const [containerId, packageContainer] of Object.entries(this.packageContainersCache)) {
			/** Is the Container writeable */
			let isWriteable = false
			for (const accessor of Object.values(packageContainer.accessors)) {
				if (accessor.allowWrite) {
					isWriteable = true
					break
				}
			}
			// All writeable packageContainers should have the clean up cronjob:
			if (isWriteable) {
				if (!packageContainerExpectations[containerId]) {
					// todo: Maybe should not all package-managers monitor,
					// this should perhaps be coordinated with the Workforce-manager, who should monitor who?

					// Add default packageContainerExpectation:
					packageContainerExpectations[containerId] = literal<PackageContainerExpectation>({
						...packageContainer,
						id: containerId,
						managerId: this._expectationManager.managerId,
						cronjobs: {
							interval: 0,
						},
						monitors: {},
					})
				}
				packageContainerExpectations[containerId].cronjobs.cleanup = {} // Add cronjob to clean up
			}
		}
	}
	private reportMonitoredPackages(_containerId: string, monitorId: string, expectedPackages: ExpectedPackage.Any[]) {
		const expectedPackagesWraps: ExpectedPackageWrap[] = []

		for (const expectedPackage of expectedPackages) {
			const wrap = this.wrapExpectedPackage(this.packageContainersCache, expectedPackage)
			if (wrap) {
				expectedPackagesWraps.push(wrap)
			}
		}

		this.monitoredPackages[monitorId] = expectedPackagesWraps

		this._triggerUpdatedExpectedPackages()
	}
}
export function omit<T, P extends keyof T>(obj: T, ...props: P[]): Omit<T, P> {
	return _.omit(obj, ...(props as string[])) as any
}

interface ResultingExpectedPackage {
	// This interface is copied from Core

	expectedPackage: ExpectedPackage.Base & { rundownId?: string }
	/** Lower should be done first */
	priority: number
	sources: PackageContainerOnPackage[]
	targets: PackageContainerOnPackage[]
	playoutDeviceId: string
	/** If set to true, this doesn't come from Core */
	external?: boolean
	// playoutLocation: any // todo?
}
export type ExpectedPackageWrap = ResultingExpectedPackage

export type PackageContainers = { [containerId: string]: PackageContainer }

export interface ActivePlaylist {
	_id: string
	active: boolean
	rehearsal: boolean
}
export interface ActiveRundown {
	_id: string
	_rank: number
}
export interface PackageManagerSettings {
	delayRemoval: number
}

/** Note: This is based on the Core method updateExpectedPackageWorkStatuses. */
type UpdateExpectedPackageWorkStatusesChanges = (
	| {
			id: string
			type: 'delete'
	  }
	| {
			id: string
			type: 'insert'
			status: ExpectedPackageStatusAPI.WorkStatus
	  }
	| {
			id: string
			type: 'update'
			status: Partial<ExpectedPackageStatusAPI.WorkStatus>
	  }
)[]
/** Note: This is based on the Core method updatePackageContainerPackageStatuses. */
type UpdatePackageContainerPackageStatusesChanges = (
	| {
			containerId: string
			packageId: string
			type: 'delete'
	  }
	| {
			containerId: string
			packageId: string
			type: 'update'
			status: ExpectedPackageStatusAPI.PackageContainerPackageStatus
	  }
)[]
