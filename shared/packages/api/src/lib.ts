import crypto from 'crypto'

/** Helper function to force the input to be of a certain type. */
export function literal<T>(o: T): T {
	return o
}
/**
 * Returns a string that changes whenever the input changes.
 * Does NOT depend on the order of object attributes.
 */
export function hashObj(obj: unknown): string {
	if (!obj) {
		return ''
	} else if (Array.isArray(obj)) {
		const strs: string[] = []
		for (const value of obj) {
			strs.push(hashObj(value))
		}
		return hash(strs.join(','))
	} else if (typeof obj === 'object') {
		if (!obj) return 'null'

		// Sort the keys, so that key order doesn't matter:
		const keys = Object.keys(obj).sort((a, b) => {
			if (a > b) return 1
			if (a < b) return -1
			return 0
		})

		const strs: string[] = []
		for (const key of keys) {
			strs.push(hashObj((obj as any)[key]))
		}
		return hash(strs.join('|'))
	} else {
		return obj + ''
	}
}
export function hash(str: string): string {
	const hash0 = crypto.createHash('sha1')
	return hash0.update(str).digest('hex')
}
