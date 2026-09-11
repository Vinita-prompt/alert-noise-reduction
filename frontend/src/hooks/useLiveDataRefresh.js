import { useEffect, useRef, useState } from 'react';
import { getLiveAlertStreamUrl } from '../services/api.js';

export default function useLiveDataRefresh(onRefresh) {
  const callback = useRef(onRefresh);
  const [connectionStatus, setConnectionStatus] = useState('CONNECTING');

  callback.current = onRefresh;

  useEffect(() => {
    if (typeof EventSource === 'undefined') {
      setConnectionStatus('POLLING');
      return undefined;
    }

    const stream = new EventSource(getLiveAlertStreamUrl(), { withCredentials: true });
    const refresh = () => callback.current?.(true);
    stream.onopen = () => setConnectionStatus('LIVE');
    stream.onerror = () => setConnectionStatus('POLLING');
    stream.addEventListener('alert', refresh);
    stream.addEventListener('evidence', refresh);
    stream.addEventListener('jira-sync', refresh);

    return () => {
      stream.removeEventListener('alert', refresh);
      stream.removeEventListener('evidence', refresh);
      stream.removeEventListener('jira-sync', refresh);
      stream.close();
    };
  }, []);

  return connectionStatus;
}
