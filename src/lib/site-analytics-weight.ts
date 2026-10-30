/**
 * How many requests one site_analytics_events row stands for. A collapsed decoy / honeytoken row
 * (recordSiteEvent folds repeats from one source into the first row of a 10-minute window) carries
 * props.repeat_count; every other row is 1. Sum this, not count(*), wherever attempts are reported.
 */
export const EVENT_WEIGHT_SQL = "COALESCE((props->>'repeat_count')::int, 1)";
