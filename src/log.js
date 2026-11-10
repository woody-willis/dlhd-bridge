/**
 * Tiny levelled logger. One line per message, ISO-8601 UTC timestamp first.
 *
 *   2026-11-10T17:38:00.000Z info catalogue refreshed {channels: 899, events: 326}
 *
 * All output is sanitised: query strings are stripped from URLs so signed
 * upstream links never end up in logs.
 */

import { config } from './config.js';

const ORDER = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const threshold = ORDER[config.logLevel] ?? ORDER.info;

const URL_WITH_QUERY = /(https?:\/\/[^\s"'<>]+?)\?[^\s"'<>]*/g;

export function redact(text) {
  return String(text).replace(URL_WITH_QUERY, '$1?…');
}

function oneLine(value) {
  return redact(value).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function describe(extra) {
  if (extra === undefined || extra === null) return '';
  if (extra instanceof Error) {
    return oneLine(JSON.stringify({ err: extra.name, message: extra.message }));
  }
  if (typeof extra === 'object') {
    try {
      return oneLine(JSON.stringify(extra));
    } catch {
      return oneLine(String(extra));
    }
  }
  return oneLine(String(extra));
}

function emit(level, message, extra) {
  if (ORDER[level] < threshold) return;
  const suffix = describe(extra);
  const line = `${new Date().toISOString()} ${level} ${oneLine(message)}${suffix ? ' ' + suffix : ''}`;
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  sink(line);
}

export function debug(message, extra) {
  emit('debug', message, extra);
}

export function info(message, extra) {
  emit('info', message, extra);
}

export function warn(message, extra) {
  emit('warn', message, extra);
}

export function error(message, extra) {
  emit('error', message, extra);
}

export default { debug, info, warn, error, redact };
