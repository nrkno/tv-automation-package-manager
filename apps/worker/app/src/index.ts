import { startProcess } from '@worker/generic'
console.log('process started') // This is a message all Sofie processes log upon startup
startProcess().catch(console.error)
