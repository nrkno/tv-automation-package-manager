import { Accessor, AccessorOnPackage } from '@sofie-automation/blueprints-integration'
import { GenericAccessorHandle } from './genericHandle'
import { Expectation } from '../expectationApi'
import { GenericWorker } from '../worker'
import fetch from 'node-fetch'
import AbortController from 'abort-controller'

/** Accessor handle for accessing files in a local folder */
export class HTTPAccessorHandle<Metadata> extends GenericAccessorHandle<Metadata> {
	constructor(
		worker: GenericWorker,
		private accessor: AccessorOnPackage.HTTP,
		private content: {
			filePath: string
		}
	) {
		super(worker, accessor, content, 'http')
	}
	doYouSupportAccess(): boolean {
		return !this.accessor.networkId || this.worker.location.localNetworkIds.includes(this.accessor.networkId)
	}
	checkHandleRead(): string | undefined {
		if (!this.accessor.allowRead) {
			return `Not allowed to read`
		}
		return this.checkAccessor()
	}
	checkHandleWrite(): string | undefined {
		if (!this.accessor.allowWrite) {
			return `Not allowed to write`
		}
		return this.checkAccessor()
	}
	private checkAccessor(): string | undefined {
		if (this.accessor.type !== Accessor.AccessType.HTTP) {
			return `HTTP Accessor type is not HTTP ("${this.accessor.type}")!`
		}
		if (!this.accessor.baseUrl) return `Accessor baseUrl not set`
		if (!this.filePath) return `filePath not set`
		return undefined // all good
	}
	async checkPackageReadAccess(): Promise<string | undefined> {
		const header = await this.fetchHeader()

		if (header.status >= 400) {
			return `Error when requesting url "${this.fullUrl}": [${header.status}]: ${header.statusText}`
		}
		return undefined // all good
	}
	async checkPackageContainerWriteAccess(): Promise<string | undefined> {
		// todo: how to check this?
		return undefined // all good
	}
	async getPackageActualVersion(): Promise<Expectation.Version.HTTPFile> {
		const header = await this.fetchHeader()

		return this.convertHeadersToVersion(header.headers)
	}
	async removePackage(): Promise<void> {
		// TODO: send DELETE request
	}

	get baseUrl(): string {
		if (!this.accessor.baseUrl) throw new Error(`HTTPAccessorHandle: accessor.baseUrl not set!`)
		return this.accessor.baseUrl
	}
	get filePath(): string {
		const filePath = this.accessor.url || this.content.filePath
		if (!filePath) throw new Error(`HTTPAccessorHandle: filePath not set!`)
		return filePath
	}
	get fullUrl(): string {
		return [
			this.baseUrl.replace(/\/$/, ''), // trim triling slash
			this.filePath.replace(/^\//, ''), // trim leading slash
		].join('/')
	}
	private convertHeadersToVersion(headers: HTTPHeaders): Expectation.Version.HTTPFile {
		return {
			type: Expectation.Version.Type.HTTP_FILE,

			contentType: headers.contentType || '',
			contentLength: parseInt(headers.contentLength || '0', 10) || 0,
			modified: headers.lastModified ? new Date(headers.lastModified).getTime() : 0,
			etags: [], // headers.etags, // todo!
		}
	}
	private async fetchHeader() {
		const controller = new AbortController()
		const res = await fetch(this.fullUrl, { signal: controller.signal })

		const headers: HTTPHeaders = {
			contentType: res.headers.get('content-type'),
			contentLength: res.headers.get('content-length'),
			lastModified: res.headers.get('last-modified'),
			etags: res.headers.get('etag'),
		}
		// We've got the headers, abort the call so we don't have to download the whole file:
		controller.abort()

		return {
			status: res.status,
			statusText: res.statusText,
			headers: headers,
		}
	}
	async getPackageReadStream(): Promise<{ readStream: NodeJS.ReadableStream; cancel: () => void }> {
		const controller = new AbortController()
		const res = await fetch(this.fullUrl, { signal: controller.signal })

		return {
			readStream: res.body,
			cancel: () => {
				controller.abort()
			},
		}
	}
	async pipePackageStream(_sourceStream: NodeJS.ReadableStream): Promise<NodeJS.WritableStream> {
		throw new Error('HTTP.pipePackageStream: Not implemented')
	}

	async fetchMetadata(): Promise<Metadata | undefined> {
		throw new Error('HTTP.fetchMetadata: Not implemented')
	}
	async updateMetadata(_metadata: Metadata): Promise<void> {
		throw new Error('HTTP.updateMetadata: Not implemented')
	}
	async removeMetadata(): Promise<void> {
		throw new Error('HTTP.removeMetadata: Not implemented')
	}
}
interface HTTPHeaders {
	contentType: string | null
	contentLength: string | null
	lastModified: string | null
	etags: string | null
}