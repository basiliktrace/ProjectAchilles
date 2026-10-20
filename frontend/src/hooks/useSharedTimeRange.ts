import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  resolveTimeRange,
  storeTimeRange,
  timeRangeToParams,
  type DateRangeValue,
} from '@/lib/timeRange';

const RANGE_PARAM_KEYS = ['date', 'from', 'to', 'range'];

/**
 * The Dashboard's time range, shared with Analytics: read from the URL, else
 * the range remembered this tab session, else the default. Changes update
 * both the URL and the remembered range. The Dashboard's old `range=` param
 * is still read so existing links keep working.
 */
export function useSharedTimeRange(): [DateRangeValue, (next: DateRangeValue) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const [range, setRangeState] = useState<DateRangeValue>(() => resolveTimeRange(searchParams, 'range'));

  useEffect(() => {
    storeTimeRange(range);
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        RANGE_PARAM_KEYS.forEach((key) => params.delete(key));
        Object.entries(timeRangeToParams(range)).forEach(([key, value]) => params.set(key, value));
        return params;
      },
      { replace: true },
    );
  }, [range, setSearchParams]);

  return [range, setRangeState];
}
