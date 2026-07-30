/**
 * Presigned PUT lifetime. Registration only mints PUT URLs for an open run, but
 * — unlike the worker path's upload handler — a presigned PUT cannot re-check
 * run/project existence when it is used. Fifteen minutes covers an immediate
 * reporter upload plus retry backoff without leaving a long-lived write grant.
 */
export const ARTIFACT_PRESIGNED_PUT_TTL_SECONDS = 15 * 60;
