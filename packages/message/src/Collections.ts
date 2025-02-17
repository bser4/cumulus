'use strict';

import { Message } from '@cumulus/types';

/**
 * Utility functions for generating collection information or parsing collection information
 * from a Cumulus message
 *
 * @module Collections
 *
 * @example
 * const Collections = require('@cumulus/message/Collections');
 */

type CollectionInfo = {
  name: string
  version: string
};

/**
 * Returns the collection ID.
 *
 * @param {string} name - collection name
 * @param {string} version - collection version
 * @returns {string} collectionId
 *
 * @alias module:Collections
 */
export const constructCollectionId = (name: string, version: string) =>
  `${name}___${version}`;

/**
 * Get collection name from execution message.
 *
 * @param {Message.CumulusMessage} message - An execution message
 * @returns {string | undefined} - Collection name or undefined
 * @private
 *
 * @alias module:Collections
 */
const getCollectionNameFromMessage = (
  message: Message.CumulusMessage
): string | undefined => message.meta?.collection?.name;

/**
 * Get collection version from execution message.
 *
 * @param {Message.CumulusMessage} message - An execution message
 * @returns {string | undefined} - Collection version or undefined
 * @private
 *
 * @alias module:Collections
 */
const getCollectionVersionFromMessage = (
  message: Message.CumulusMessage
): string | undefined => message.meta?.collection?.version;

/**
 * Get collection name and version from execution message.
 *
 * @param {Message.CumulusMessage} message - An execution message
 * @returns {CollectionInfo | undefined}
 *   Object with collection name and version or undefined
 *
 * @alias module:Collections
 */
export const getCollectionNameAndVersionFromMessage = (
  message: Message.CumulusMessage
): CollectionInfo | undefined => {
  const name = getCollectionNameFromMessage(message);
  const version = getCollectionVersionFromMessage(message);
  if (!name || !version) {
    return undefined;
  }
  return {
    name,
    version,
  };
};

/**
 * Get collection ID from execution message.
 *
 * @param {Message.CumulusMessage} message - An execution message
 * @returns {string | undefined} - A collection ID or undefined if
 *                                 message.meta.collection isn't
 *                                 present
 *
 * @alias module:Collections
 */
export const getCollectionIdFromMessage = (
  message: Message.CumulusMessage
): string | undefined => {
  const collectionName = getCollectionNameFromMessage(message);
  const collectionVersion = getCollectionVersionFromMessage(message);
  if (!collectionName || !collectionVersion) {
    return undefined;
  }
  return constructCollectionId(collectionName, collectionVersion);
};
