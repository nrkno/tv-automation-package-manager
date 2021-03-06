import { Connector, Config } from './connector'
import { getPackageManagerConfig, LoggerInstance, setupLogging } from '@shared/api'

export { Connector, Config }
export function startProcess(startInInternalMode?: boolean): { logger: LoggerInstance; connector: Connector } {
	const config = getPackageManagerConfig()

	const logger = setupLogging(config)

	logger.info('------------------------------------------------------------------')
	logger.info('Starting Package Manager')
	if (config.packageManager.disableWatchdog) logger.info('Watchdog is disabled!')
	if (startInInternalMode) {
		config.packageManager.port = null
		config.packageManager.accessUrl = null
		config.packageManager.workforceURL = null
	}
	const connector = new Connector(logger, config)

	logger.info('Core:          ' + config.packageManager.coreHost + ':' + config.packageManager.corePort)
	logger.info('------------------------------------------------------------------')

	if (!startInInternalMode) {
		connector.init().catch((e) => {
			logger.error(e)
		})
	}
	return { logger, connector }
}
