/**
 * How many requests one site_analytics_events row stands for. A collapsed decoy / honeytoken row
 * (recordSiteEvent folds repeats from one source into the first row of a 10-minute window) carries
 * props.repeat_count; every other row is 1. Sum this, not count(*), wherever attempts are reported.
 * Guarded: a malformed repeat_count counts as 1 instead of failing the whole query.
 */
export const EVENT_WEIGHT_SQL = "CASE WHEN props->>'repeat_count' ~ '^[0-9]{1,9}$' THEN (props->>'repeat_count')::int ELSE 1 END";
