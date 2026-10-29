/*
 * The audit log: who did what and when (sign-ins, changes, password views, deletions).
 */
import { run, now } from '../db.js';
import { clientIp } from '../http.js';

/**
 * The audit INSERT as a batch item, so it can ride in the same database round trip as the change
 * it records: batch([...writes, auditStmt(req, 'thing.done', ...)]).
 * @param {import('express').Request|null} req  request (actor is taken from req.user unless actor is given)
 */
export function auditStmt(req, action, entity = null, entityId = null, details = '', actor = null) {
  const who = actor || req?.user || null;
  return [
    'INSERT INTO audit_log(actor_id,actor_name,action,entity,entity_id,details,ip,created_at) VALUES(?,?,?,?,?,?,?,?)',
    who?.id ?? null,
    who?.name ?? who?.username ?? null,
    action,
    entity,
    entityId == null ? null : String(entityId),
    typeof details === 'string' ? details : JSON.stringify(details),
    req ? clientIp(req) : null,
    now(),
  ];
}

/** Append an immutable audit entry on its own. */
export async function audit(...args) {
  const [sql, ...params] = auditStmt(...args);
  await run(sql, ...params);
}
