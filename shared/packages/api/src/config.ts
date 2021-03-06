import { Options } from 'yargs'
import yargs = require('yargs/yargs')
import _ from 'underscore'
import { WorkerAgentConfig } from './worker'

/*
 * This file contains various CLI argument definitions, used by the various processes that together constitutes the Package Manager
 */

/** Generic CLI-argument-definitions for any process */
const processOptions = defineArguments({
	logPath: { type: 'string', describe: 'Set to write logs to this file' },

	unsafeSSL: {
		type: 'boolean',
		default: process.env.UNSAFE_SSL === '1',
		describe: 'Set to true to allow all SSL certificates (only use this in a safe, local environment)',
	},
	certificates: { type: 'string', describe: 'SSL Certificates' },
})
/** CLI-argument-definitions for the Workforce process */
const workforceArguments = defineArguments({
	port: {
		type: 'number',
		default: parseInt(process.env.WORKFORCE_PORT || '', 10) || 8070,
		describe: 'The port number to start the Workforce websocket server on',
	},
})
/** CLI-argument-definitions for the HTTP-Server process */
const httpServerArguments = defineArguments({
	httpServerPort: {
		type: 'number',
		default: parseInt(process.env.HTTP_SERVER_PORT || '', 10) || 8080,
		describe: 'The port number to use for the HTTP server',
	},
	apiKeyRead: {
		type: 'string',
		default: process.env.HTTP_SERVER_API_KEY_READ || undefined,
		describe: 'Set this to limit read-access',
	},
	apiKeyWrite: {
		type: 'string',
		default: process.env.HTTP_SERVER_API_KEY_WRITE || undefined,
		describe: 'Set this to limit write-access',
	},
	basePath: {
		type: 'string',
		default: process.env.HTTP_SERVER_BASE_PATH || './fileStorage',
		describe: 'The internal path to use for file storage',
	},
})
/** CLI-argument-definitions for the Package Manager process */
const packageManagerArguments = defineArguments({
	coreHost: {
		type: 'string',
		default: process.env.CORE_HOST || '127.0.0.1',
		describe: 'The IP-address/hostName to Sofie Core',
	},
	corePort: {
		type: 'number',
		default: parseInt(process.env.CORE_PORT || '', 10) || 3000,
		describe: 'The port number of Sofie core (usually 80, 443 or 3000)',
	},

	deviceId: {
		type: 'string',
		default: process.env.DEVICE_ID || '',
		describe: '(Optional) Unique devide id of this device',
	},
	deviceToken: {
		type: 'string',
		default: process.env.DEVICE_TOKEN || '',
		describe: '(Optional) access token of this device.',
	},

	disableWatchdog: {
		type: 'boolean',
		default: process.env.DISABLE_WATCHDOG === '1',
		describe: 'Set to true to disable the Watchdog (it kills the process if connection to Core is lost)',
	},

	port: {
		type: 'number',
		default: parseInt(process.env.PACKAGE_MANAGER_PORT || '', 10) || 8060,
		describe: 'The port number to start the Package Manager websocket server on',
	},
	accessUrl: {
		type: 'string',
		default: process.env.PACKAGE_MANAGER_URL || 'ws://localhost:8060',
		describe: 'The URL where Package Manager websocket server can be accessed',
	},
	workforceURL: {
		type: 'string',
		default: process.env.WORKFORCE_URL || 'ws://localhost:8070',
		describe: 'The URL to the Workforce',
	},
	watchFiles: {
		type: 'boolean',
		default: process.env.WATCH_FILES === '1',
		describe: 'If true, will watch the file "expectedPackages.json" as an additional source of expected packages.',
	},
})
/** CLI-argument-definitions for the Worker process */
const workerArguments = defineArguments({
	workerId: { type: 'string', default: process.env.WORKER_ID || 'worker0', describe: 'Unique id of the worker' },
	workforceURL: {
		type: 'string',
		default: process.env.WORKFORCE_URL || 'ws://localhost:8070',
		describe: 'The URL to the Workforce',
	},
	windowsDriveLetters: {
		type: 'string',
		default: process.env.WORKER_WINDOWS_DRIVE_LETTERS || 'X;Y;Z',
		describe: 'Which Windows Drive letters can be used to map shares. ("X;Y;Z") ',
	},
	resourceId: {
		type: 'string',
		default: process.env.WORKER_NETWORK_ID || 'default',
		describe: 'Identifier of the local resource/computer this worker runs on',
	},
	networkIds: {
		type: 'string',
		default: process.env.WORKER_NETWORK_ID || 'default',
		describe: 'Identifier of the local networks this worker has access to ("networkA;networkB")',
	},
})
/** CLI-argument-definitions for the "Single" process */
const singleAppArguments = defineArguments({
	workerCount: {
		type: 'number',
		default: parseInt(process.env.WORKER_COUNT || '', 10) || 1,
		describe: 'How many workers to spin up',
	},
})
/** CLI-argument-definitions for the Quantel-HTTP-Transformer-Proxy process */
const quantelHTTPTransformerProxyConfigArguments = defineArguments({
	quantelProxyPort: {
		type: 'number',
		default: parseInt(process.env.QUANTEL_HTTP_TRANSFORMER_PROXY_PORT || '', 10) || 8081,
		describe: 'The port on which to server the Quantel-HTTP-Transformer-Proxy server on',
	},
	quantelTransformerURL: {
		type: 'string',
		default: process.env.QUANTEL_HTTP_TRANSFORMER_URL || undefined,
		describe: 'URL to the Quantel-HTTP-Transformer',
	},
})

export interface ProcessConfig {
	logPath: string | undefined
	/** Will cause the Node applocation to blindly accept all certificates. Not recommenced unless in local, controlled networks. */
	unsafeSSL: boolean
	/** Paths to certificates to load, for SSL-connections */
	certificates: string[]
}
function getProcessConfig(argv: { logPath: string | undefined; unsafeSSL: boolean; certificates: string | undefined }) {
	const certs: string[] = (argv.certificates || process.env.CERTIFICATES || '').split(';') || []
	return {
		logPath: argv.logPath,
		unsafeSSL: argv.unsafeSSL,
		certificates: _.compact(certs),
	}
}
// Configuration for the Workforce Application: ------------------------------
export interface WorkforceConfig {
	process: ProcessConfig
	workforce: {
		port: number | null
	}
}
export function getWorkforceConfig(): WorkforceConfig {
	const argv = yargs(process.argv.slice(2)).options({
		...workforceArguments,
		...processOptions,
	}).argv

	return {
		process: getProcessConfig(argv),
		workforce: {
			port: argv.port,
		},
	}
}
// Configuration for the HTTP server Application: ----------------------------------
export interface HTTPServerConfig {
	process: ProcessConfig
	httpServer: {
		port: number

		basePath: string
		apiKeyRead: string | undefined
		apiKeyWrite: string | undefined
	}
}
export function getHTTPServerConfig(): HTTPServerConfig {
	const argv = yargs(process.argv.slice(2)).options({
		...httpServerArguments,
		...processOptions,
	}).argv

	if (!argv.apiKeyWrite && argv.apiKeyRead) {
		throw `Error: When apiKeyRead is given, apiKeyWrite is required!`
	}

	return {
		process: getProcessConfig(argv),
		httpServer: {
			port: argv.httpServerPort,
			basePath: argv.basePath,
			apiKeyRead: argv.apiKeyRead,
			apiKeyWrite: argv.apiKeyWrite,
		},
	}
}
// Configuration for the Package Manager Application: ------------------------------
export interface PackageManagerConfig {
	process: ProcessConfig
	packageManager: {
		coreHost: string
		corePort: number
		deviceId: string
		deviceToken: string
		disableWatchdog: boolean

		port: number | null
		accessUrl: string | null
		workforceURL: string | null

		watchFiles: boolean
	}
}
export function getPackageManagerConfig(): PackageManagerConfig {
	const argv = yargs(process.argv.slice(2)).options({
		...packageManagerArguments,
		...processOptions,
	}).argv

	return {
		process: getProcessConfig(argv),
		packageManager: {
			coreHost: argv.coreHost,
			corePort: argv.corePort,
			deviceId: argv.deviceId,
			deviceToken: argv.deviceToken,
			disableWatchdog: argv.disableWatchdog,

			port: argv.port,
			accessUrl: argv.accessUrl,
			workforceURL: argv.workforceURL,

			watchFiles: argv.watchFiles,
		},
	}
}
// Configuration for the Worker Application: ------------------------------
export interface WorkerConfig {
	process: ProcessConfig
	worker: {
		workforceURL: string | null
		resourceId: string
		networkIds: string[]
	} & WorkerAgentConfig
}
export function getWorkerConfig(): WorkerConfig {
	const argv = yargs(process.argv.slice(2)).options({
		...workerArguments,
		...processOptions,
	}).argv

	return {
		process: getProcessConfig(argv),
		worker: {
			workerId: argv.workerId,
			workforceURL: argv.workforceURL,
			windowsDriveLetters: argv.windowsDriveLetters ? argv.windowsDriveLetters.split(';') : [],
			resourceId: argv.resourceId,
			networkIds: argv.networkIds ? argv.networkIds.split(';') : [],
		},
	}
}

// Configuration for the Single-app Application: ------------------------------
export interface SingleAppConfig
	extends WorkforceConfig,
		HTTPServerConfig,
		PackageManagerConfig,
		WorkerConfig,
		QuantelHTTPTransformerProxyConfig {
	singleApp: {
		workerCount: number
	}
}

export function getSingleAppConfig(): SingleAppConfig {
	const options = {
		...workforceArguments,
		...httpServerArguments,
		...packageManagerArguments,
		...workerArguments,
		...processOptions,
		...singleAppArguments,
		...quantelHTTPTransformerProxyConfigArguments,
	}
	// Remove some that are not used in the Single-App, so that they won't show up when running '--help':

	// @ts-expect-error not optional
	delete options.corePort
	// @ts-expect-error not optional
	delete options.accessUrl
	// @ts-expect-error not optional
	delete options.workforceURL
	// @ts-expect-error not optional
	delete options.port

	const argv = yargs(process.argv.slice(2)).options(options).argv

	return {
		process: getProcessConfig(argv),
		workforce: getWorkforceConfig().workforce,
		httpServer: getHTTPServerConfig().httpServer,
		packageManager: getPackageManagerConfig().packageManager,
		worker: getWorkerConfig().worker,
		singleApp: {
			workerCount: argv.workerCount || 1,
		},
		quantelHTTPTransformerProxy: getQuantelHTTPTransformerProxyConfig().quantelHTTPTransformerProxy,
	}
}
// Configuration for the HTTP server Application: ----------------------------------
export interface QuantelHTTPTransformerProxyConfig {
	process: ProcessConfig
	quantelHTTPTransformerProxy: {
		port: number

		transformerURL?: string
	}
}
export function getQuantelHTTPTransformerProxyConfig(): QuantelHTTPTransformerProxyConfig {
	const argv = yargs(process.argv.slice(2)).options({
		...quantelHTTPTransformerProxyConfigArguments,
		...processOptions,
	}).argv

	return {
		process: getProcessConfig(argv),
		quantelHTTPTransformerProxy: {
			port: argv.quantelProxyPort,
			transformerURL: argv.quantelTransformerURL,
		},
	}
}
// ---------------------------------------------------------------------------------

/** Helper function, to get strict typings for the yargs-Options. */
function defineArguments<O extends { [key: string]: Options }>(opts: O): O {
	return opts
}
