import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Checkpoint, MapPackage } from '../data/models';
import { getServices, type Services } from '../tracking/runtime';
import type { TrackingStatus } from '../tracking/trackingController';

export function useServices(): { services: Services | null; error: string | null; retry: () => void } {
  const [services, setServices] = useState<Services | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    getServices()
      .then((s) => alive && setServices(s))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [attempt]);
  return {
    services,
    error,
    retry: () => {
      setError(null);
      setAttempt((a) => a + 1);
    },
  };
}

/** Live tracking/engine/audio status from the shared controller. */
const noopSubscribe = () => () => undefined;

export function useTrackingStatus(services: Services | null): TrackingStatus | null {
  const controller = services?.controller ?? null;
  const subscribe = useCallback(
    (onChange: () => void) => (controller ? controller.subscribe(onChange) : noopSubscribe()),
    [controller],
  );
  const getSnapshot = useCallback(() => controller?.getSnapshot() ?? null, [controller]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Checkpoints list, reloaded whenever the screen gains focus. */
export function useCheckpoints(services: Services | null) {
  const [list, setList] = useState<Checkpoint[]>([]);
  const reload = useCallback(async () => {
    if (services) setList(await services.checkpoints.list());
  }, [services]);
  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );
  return { checkpoints: list, reload };
}

export function useUsableMapPackage(services: Services | null) {
  const [pkg, setPkg] = useState<MapPackage | null>(null);
  const [checked, setChecked] = useState(false);
  useFocusEffect(
    useCallback(() => {
      if (!services) return;
      void services.mapPackages.findUsable().then((p) => {
        setPkg(p);
        setChecked(true);
      });
    }, [services]),
  );
  return { pkg, checked };
}

export function useInterval(fn: () => void, ms: number) {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  useEffect(() => {
    const id = setInterval(() => ref.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}
