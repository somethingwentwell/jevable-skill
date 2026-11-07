import { spawn } from 'node:child_process';
export class ImageError extends Error {
    code;
    build;
    constructor(code, build) {
        super(`Jevable image operation failed: ${code}. Local image state may have changed; inspect before retrying. No registry push was requested.`);
        this.code = code;
        this.build = build;
        this.name = 'ImageError';
    }
}
/** No shell or implicit remote builder. The caller supplies an explicitly checked --context. */
export const dockerCommand = async (args, options = {}) => {
    if (options.input !== undefined && (!(options.input instanceof Uint8Array) || options.input.byteLength > 1_000_000))
        throw new ImageError('invalid-image-options');
    const input = options.input === undefined ? undefined : Buffer.from(options.input);
    const env = { ...process.env, DOCKER_BUILDKIT: '1', BUILDX_METADATA_PROVENANCE: 'disabled', BUILDX_METADATA_WARNINGS: '0' };
    for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'BUILDX_BUILDER', 'BUILDKIT_HOST', 'BUILDX_BAKE_FILE'])
        delete env[key];
    const child = spawn('docker', args, { shell: false, env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let failure, hardKill;
    const kill = (signal) => {
        try {
            if (child.pid && process.platform !== 'win32')
                process.kill(-child.pid, signal);
            else
                child.kill(signal);
        }
        catch { }
    };
    const stop = () => { kill('SIGTERM'); hardKill ??= setTimeout(() => kill('SIGKILL'), 1000); };
    const timeout = setTimeout(() => { failure = new ImageError('docker-timeout'); stop(); }, options.timeoutMs ?? 15000);
    const chunks = [];
    const exit = new Promise((resolve, reject) => {
        child.once('error', () => reject(new ImageError('docker-unavailable')));
        child.once('close', code => code === 0 ? resolve() : reject(failure ?? new ImageError('docker-command-failed')));
    });
    const stdout = (async () => {
        let bytes = 0;
        for await (const value of child.stdout) {
            const chunk = Buffer.from(value);
            if (options.consumeStdout)
                await options.consumeStdout(chunk);
            else {
                bytes += chunk.length;
                if (bytes > 2_000_000)
                    throw new ImageError('docker-output-limit');
                chunks.push(chunk);
            }
        }
    })();
    const stderr = (async () => {
        let bytes = 0;
        for await (const value of child.stderr) {
            bytes += Buffer.byteLength(value);
            if (bytes > 2_000_000)
                throw new ImageError('docker-output-limit');
        }
    })();
    const stdin = input === undefined ? Promise.resolve() : new Promise((resolve, reject) => {
        child.stdin.once('error', () => reject(new ImageError('docker-command-failed')));
        child.stdin.end(input, () => resolve());
    });
    try {
        await Promise.all([exit, stdout, stderr, stdin]);
        if (failure)
            throw failure;
        return Buffer.concat(chunks).toString('utf8');
    }
    catch (error) {
        stop();
        await Promise.allSettled([exit, stdout, stderr, stdin]);
        throw error;
    }
    finally {
        clearTimeout(timeout);
        clearTimeout(hardKill);
    }
};
