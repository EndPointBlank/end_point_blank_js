'use strict';

/**
 * Represents a log entry capturing details about an error or interaction.
 *
 * Equivalent to the Ruby gem's `EndPointBlank::LogEntry`.
 */
class LogEntry {
  /**
   * @param {object} opts
   * @param {string} opts.message
   * @param {string[]|null} opts.stacktrace
   * @param {string|null} opts.app
   * @param {number} opts.status
   * @param {object} opts.headers
   * @param {string|null} opts.body
   * @param {object|null} opts.env
   * @param {Date} [opts.sentAt]
   */
  constructor({ message, stacktrace, app, status, headers, body, env, sentAt }) {
    this.message = message;
    this.stacktrace = stacktrace;
    this.app = app;
    this.status = status;
    this.headers = headers;
    this.body = body;
    this.env = env;
    this.sentAt = sentAt || new Date();
  }
}

module.exports = { LogEntry };
