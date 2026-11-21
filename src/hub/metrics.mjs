// SPDX-License-Identifier: AGPL-3.0-only
// What a hub tells whoever watches it: counts, in the text format of Prometheus, on a port of its own
// that listens only on this machine. Nothing in them says who: no DID, no topic name, no address.

import http from 'node:http';

const line = (name, value, labels = {}) => {
  const tags = Object.entries(labels).map(([key, label]) => `${key}="${label}"`).join(',');
  return `${name}${tags ? `{${tags}}` : ''} ${value}`;
};

/** The metrics of a hub, from a function that says how things stand (`read`). */
export function renderMetrics(read) {
  const now = read();
  const out = [];
  const gauge = (name, help, values) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    for (const [labels, value] of values) out.push(line(name, value, labels));
  };
  const counter = (name, help, values) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`);
    for (const [labels, value] of values) out.push(line(name, value, labels));
  };
  gauge('agenthub_agents', 'Registered agents, by status.', Object.entries(now.agents).map(([status, count]) => [{ status }, count]));
  gauge('agenthub_instances', 'Instances that have not been removed.', [[{}, now.instances]]);
  gauge('agenthub_topics', 'Topics.', [[{}, now.topics]]);
  gauge('agenthub_inbox_entries', 'Entries waiting in inboxes, all readers together.', [[{}, now.inboxEntries]]);
  gauge('agenthub_streams_open', 'Open streams of readers.', [[{}, now.streams]]);
  gauge('agenthub_peers', 'Paired hubs, by the state of the pairing.', Object.entries(now.peers).map(([state, count]) => [{ state }, count]));
  gauge('agenthub_log_entries', 'Entries of the transparency log.', [[{}, now.logEntries]]);
  gauge('agenthub_suspended', 'Agents and topics suspended by the operators.', [[{}, now.suspended]]);
  gauge('agenthub_reports', 'Reports kept for the operators.', [[{}, now.reports]]);
  counter('agenthub_requests_total', 'Requests answered since start, by class of status.', Object.entries(now.requests).map(([status, count]) => [{ status }, count]));
  counter('agenthub_journal_operations_total', 'Operations written to the journal since the data began.', [[{}, now.operations]]);
  gauge('agenthub_uptime_seconds', 'Seconds since the hub started.', [[{}, now.uptime]]);
  gauge('agenthub_memory_rss_bytes', 'Resident memory of the process.', [[{}, process.memoryUsage().rss]]);
  return `${out.join('\n')}\n`;
}

/** A server for the metrics alone, on 127.0.0.1: GET /metrics. */
export function metricsServer(read) {
  return http.createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' }).end(renderMetrics(read));
  });
}
