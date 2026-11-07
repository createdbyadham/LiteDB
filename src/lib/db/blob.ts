// Kept apart from native.ts so modules the self-test runs in Node can use it
// without importing Tauri.

/** A blob too large to send whole for display. Exports ask for it in full. */
export class OmittedBlob {
    constructor(public readonly size: number) {}
    toString(): string {
        return `${this.size.toLocaleString()} bytes`;
    }
}
