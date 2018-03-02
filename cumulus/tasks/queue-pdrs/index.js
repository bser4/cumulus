'use strict';

const cumulusMessageAdapter = require('@cumulus/cumulus-message-adapter-js');
const { enqueueParsePdrMessage } = require('@cumulus/ingest/queue');

async function queuePdrs(event) {
  const pdrs = event.input.pdrs || [];

  await Promise.all(
    pdrs.map((pdr) => enqueueParsePdrMessage(
      pdr,
      event.config.queueUrl,
      event.config.parsePdrMessageTemplateUri,
      event.config.provider,
      event.config.collection
    ))
  );

  return { pdrs_queued: pdrs.length };
}
exports.queuePdrs = queuePdrs;

/**
 * Lambda handler
 *
 * @param {Object} event - a Cumulus Message
 * @param {Object} context - an AWS Lambda context
 * @param {Function} callback - an AWS Lambda handler
 * @returns {undefined} - does not return a value
 */
function handler(event, context, callback) {
  cumulusMessageAdapter.runCumulusTask(queuePdrs, event, context, callback);
}
exports.handler = handler;
