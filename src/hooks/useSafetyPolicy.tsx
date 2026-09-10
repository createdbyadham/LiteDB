// React binding for the connection's safety policy.
//
// The policy lives in queryGate as module state because the services need to
// read it synchronously, from outside React. This hook is the other direction:
// it lets the UI show the current mode and change it, and re-renders when
// either the policy or the active connection changes.
//
// Subscribes to a window event rather than polling, so a connection opened
// elsewhere in the app updates the status bar immediately instead of on the
// next unrelated render.

import { useCallback, useEffect, useState } from 'react';
import {
    activeConnection,
    activePolicy,
    setPolicyFor,
    type ActiveConnection,
} from '@/lib/queryGate';
import type { SafetyPolicy } from '@/lib/sqlPolicy';

export interface UseSafetyPolicy {
    connection: ActiveConnection | null;
    policy: SafetyPolicy;
    /** No-op when no connection is open — there is nothing to scope it to. */
    setPolicy: (policy: SafetyPolicy) => void;
}

export function useSafetyPolicy(): UseSafetyPolicy {
    const [connection, setConnection] = useState<ActiveConnection | null>(activeConnection);
    const [policy, setPolicyState] = useState<SafetyPolicy>(activePolicy);

    useEffect(() => {
        const sync = () => {
            setConnection(activeConnection());
            setPolicyState(activePolicy());
        };
        // Also sync on mount: a connection may have opened between the initial
        // useState call and this effect running.
        sync();
        window.addEventListener('sqlPolicyChanged', sync);
        return () => window.removeEventListener('sqlPolicyChanged', sync);
    }, []);

    const setPolicy = useCallback((next: SafetyPolicy) => {
        const current = activeConnection();
        if (!current) return;
        setPolicyFor(current.id, next);
    }, []);

    return { connection, policy, setPolicy };
}
