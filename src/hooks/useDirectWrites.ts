// React binding for "let agents make small changes without asking", for the
// connection on screen. See src/lib/agentDirectWrites.ts.

import { useCallback, useEffect, useState } from 'react';
import {
    DIRECT_WRITES_CHANGED,
    directWritesFor,
    setDirectWrites,
    type DirectWrites,
} from '@/lib/agentDirectWrites';
import type { ActiveConnection } from '@/lib/queryGate';

export interface UseDirectWrites {
    /** In effect now: null when off, and always on a production connection. */
    directWrites: DirectWrites | null;
    /** No-op when no connection is open, or it is tagged production. */
    setDirectWrites: (next: DirectWrites | null) => void;
}

export function useDirectWrites(connection: ActiveConnection | null): UseDirectWrites {
    const id = connection?.id ?? null;
    const production = connection?.production ?? false;
    const [value, setValue] = useState<DirectWrites | null>(() =>
        id ? directWritesFor(id, production) : null,
    );

    useEffect(() => {
        const sync = () => setValue(id ? directWritesFor(id, production) : null);
        sync();
        window.addEventListener(DIRECT_WRITES_CHANGED, sync);
        return () => window.removeEventListener(DIRECT_WRITES_CHANGED, sync);
    }, [id, production]);

    const set = useCallback(
        (next: DirectWrites | null) => {
            if (!id || production) return;
            setDirectWrites(id, next);
        },
        [id, production],
    );

    return { directWrites: value, setDirectWrites: set };
}
