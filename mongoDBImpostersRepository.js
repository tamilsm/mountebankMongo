'use strict';

const { MongoClient } = require('mongodb');
const errors = require('./utils/errors');

/* TODO:
 * Error handling
*/
function create (config, logger) {
  const mongoCfg = getMongoConfig(config, logger),
    client = new MongoClient(mongoCfg.uri);
  client.connect();

  const imposterFns = {};

  /**
   * Saves a reference to the imposter so that the functions
   * (which can't be persisted) can be rehydrated to a loaded imposter.
   * This means that any data in the function closures will be held in
   * memory.
   * @memberOf module:mongoDBImpostersRepository#
   * @param {Object} imposter - the imposter
   */
  function addReference (imposter) {
    const id = String(imposter.port);
    imposterFns[id] = {};
    Object.keys(imposter).forEach(key => {
        if (typeof imposter[key] === 'function') {
            imposterFns[id][key] = imposter[key];
        }
    });
  }

  /**
   * Functions saved in addReference method for each imposter
   * is added back to the imposter
   * @memberOf module:mongoDBImpostersRepository#
   * @param {Object} imposter - the imposter
   * @returns {Object} - the promise
   */
  function rehydrate (imposter) {
    const id = String(imposter.port);
    if (!imposterFns[id]) {
      return imposter;
    }
    Object.keys(imposterFns[id]).forEach(key => {
        imposter[key] = imposterFns[id][key];
    });
    return imposter;
  }

  /**
   * Adds a new imposter
   * @memberOf module:mongoDBImpostersRepository#
   * @param {Object} imposter - the imposter to add
   * @returns {Object} - the promise
   */
  async function add (imposter) {
    if (!imposter.creationRequest.stubs) {
      imposter.creationRequest.stubs = [];
    }

    const doc = {};
    doc[imposter.port] = imposter.creationRequest;
    await client.db(mongoCfg.db).collection('imposters').insertOne(doc);

    addReference(imposter);
    return imposter;
  }

  async function update (imposter) {
    const doc = {},
      options = {};
    doc[imposter.port] = imposter;
    options[imposter.port] = { $exists: true };
    await client.db(mongoCfg.db).collection('imposters').replaceOne(options, doc);
  }

  /**
   * Gets the imposter by id
   * @memberOf module:mongoDBImpostersRepository#
   * @param {Number} id - the id of the imposter (e.g. the port)
   * @returns {Object} - the imposter
   */
  async function get (id) {
    let result;
    const database = client.db(mongoCfg.db),
      options = {};
    options[id] = { $exists: true };
    result = await database.collection('imposters').findOne(options);

    if (result) {
      const imposter = result[String(id)];
      rehydrate(imposter);
      return imposter;
    } else {
      return null;
    }
  }

  /**
   * Gets all imposters
   * @memberOf module:mongoDBImpostersRepository#
   * @returns {Object} - all imposters keyed by port
   */
  async function all () {
    let result = await client.db(mongoCfg.db).collection('imposters').find().toArray();
    const res = result.map(imp => { return rehydrate(Object.entries(imp)[0][1]); });
    return res;
  }

  /**
   * Returns whether an imposter at the given id exists or not
   * @memberOf module:mongoDBImpostersRepository#
   * @param {Number} id - the id (e.g. the port)
   * @returns {boolean}
   */
  async function exists (id) {
    let result;
    const database = client.db(mongoCfg.db),
      options = {};
    options[id] = { $exists: true };
    result = await database.collection('imposters').findOne(options);

    if (result) {
      return true;
    } else {
      return false;
    }
  }

  /**
   * Deletes the imposter at the given id
   * @memberOf module:mongoDBImpostersRepository#
   * @param {Number} id - the id (e.g. the port)
   * @returns {Object} - the deletion promise
   */
  async function del (id) {
    let result;
    const database = client.db(mongoCfg.db),
      options = {};
    options[id] = { $exists: true };

    const imposter = await get(id);
    if (imposter) {
      result = await database.collection('imposters').findOneAndDelete(options);

      if (imposter.stop && typeof imposter.stop === 'function') {
        await imposter.stop();
      }

      if (result.value) {
        const res = result.value[String(id)];
        return res;
      } else {
        return null;
      }
    } else {
      return null;
    }
  }

  /**
   * Deletes all imposters synchronously; used during shutdown
   * @memberOf module:mongoDBImpostersRepository#
   */
  async function stopAllSync () {
    await deleteAll(async () => {
      await client.close();
    });
  }

  /**
   * Deletes all imposters
   * @memberOf module:mongoDBImpostersRepository#
   * @param {Function} callback - callback fn
   * @returns {Object} - the deletion promise
   */
  async function deleteAll (callback) {
    const imposters = await all();
    if (imposters.length > 0) {
      await imposters.forEach(async imposter => {
        if (imposter.stop && typeof imposter.stop === 'function') {
          await imposter.stop();
        }
      });
      await client.db(mongoCfg.db).collection('imposters').deleteMany({});
    }
    if (callback) {
      await callback();
    }
  }

  /**
   * Returns the stub repository for the given id
   * @memberOf module:mongoDBImpostersRepository#
   * @param {Number} id - the imposter's id
   * @returns {Object} - the stub repository
   */
  function stubsFor (id) {
    return stubRepository(id);
  }

  /**
   * Use createImposterFrom method from mb to create imposter
   * that exists in the database on load
   * @memberOf module:mongoDBImpostersRepository#
   * @param {*} imposterConfig - imposter configuration
   * @param {*} protocols - all protocols from mb
   * @returns {Object} - the promise
   */
  // eslint-disable-next-line consistent-return
  async function loadImposter (imposterConfig, protocols) {
    const protocol = protocols[imposterConfig.protocol];

    if (protocol) {
      if (config.debug) {
        logger.info(`Loading ${ imposterConfig.protocol }:${ imposterConfig.port } from db`);
      }
      try {
        const imposter = await protocol.createImposterFrom(imposterConfig);
        addReference(imposter);
        return imposter;
      } catch (e) {
        logger.error(e, `Cannot load imposter ${ imposterConfig.port }`);
      }
    } else {
      logger.error(`Cannot load imposter ${ imposterConfig.port }; no protocol loaded for ${ config.protocol }`);
    }
  }

  /**
   * Called at startup to load saved imposters.
   * Does nothing for in memory repository
   * @memberOf module:mongoDBImpostersRepository#
   * @param {*} protocols - all protocols from mb
   * @returns {Object} - a promise
   */
  async function loadAll (protocols) {
    let allImposters = await client.db(mongoCfg.db).collection('imposters').find().toArray();
    const promises = allImposters.map(imposter => loadImposter(Object.entries(imposter)[0][1], protocols));
    await Promise.all(promises);
    return;
  }

  // For testing purposes
  async function connect () {
    await client.connect();
  }

  // For testing purposes
  async function close () {
    await client.close();
  }

  // For testing purposes
  async function teardown () {
    try {
      if (!client || !client.topology || !client.topology.isConnected()) {
        await client.connect();
      }
      await client.db(mongoCfg.db).dropCollection('imposters');
    } finally {
      await client.close(true);
    }
  }

  /**
   * Creates the stubs repository for a single imposter
   * @memberOf module:mongoDBImpostersRepository#
   * @param {Object} imposterId - imposter id (port number)
   * @returns {Object}
   */
  function stubRepository (imposterId) {
    let requests = [];

    async function reindex (stubs) {
      // stubIndex() is used to find the right spot to insert recorded
      // proxy responses. We reindex after every state change
      const imposter = await get(imposterId);
      stubs.forEach((stub, index) => {
        stub.stubIndex = async () => index;
      });
      imposter.stubs = stubs;
      await update(imposter);
    }

    /**
     * Returns the number of stubs for the imposter
     * @memberOf module:mongoDBImpostersRepository#
     * @returns {Object} - the promise
     */
    async function count () {
      const imposter = await get(imposterId);
      if (!imposter) {
        return 0;
      }
      const stubs = imposter.stubs;
      return stubs.length;
    }


    /**
     * Returns the first stub whose predicates match the filter, or a default one if none match
     * @memberOf module:mongoDBImpostersRepository#
     * @param {Function} filter - the filter function
     * @param {Number} startIndex - the index to to start searching
     * @returns {Object}
     */
    async function first (filter, startIndex = 0) {
      const imposter = await get(imposterId);
      await reindex(imposter.stubs);
      for (let i = startIndex; i < imposter.stubs.length; i += 1) {
        if (filter(imposter.stubs[i].predicates || [])) {
          return { success: true, stub: wrap(imposter.stubs[i]) };
        }
      }
      return { success: false, stub: wrap() };
    }

    async function addAll (newStubs) {
      const imposter = await get(imposterId);
      const stubs = imposter.stubs;
      newStubs.forEach(stub => {
        stubs.push(wrap(stub));
      });
      await reindex(stubs);
    }

    /**
     * Adds a new stub
     * @memberOf module:mongoDBImpostersRepository#
     * @param {Object} stub - the stub to add
     * @returns {Object} - the promise
     */
    // eslint-disable-next-line no-shadow
    async function add (stub) {
      const imposter = await get(imposterId);
      const stubs = imposter.stubs || [];
      stubs.push(wrap(stub));
      await reindex(stubs);
    }

    /**
     * Inserts a new stub at the given index
     * @memberOf module:mongoDBImpostersRepository#
     * @param {Object} stub - the stub to insert
     * @param {Number} index - the index to add the stub at
     * @returns {Object} - the promise
     */
    async function insertAtIndex (stub, index) {
      const imposter = await get(imposterId);
      const stubs = imposter.stubs;
      stubs.splice(index, 0, wrap(stub));
      await reindex(stubs);
    }

    /**
     * Overwrites the list of stubs with a new list
     * @memberOf module:mongoDBImpostersRepository#
     * @param {Object} newStubs - the new list of stubs
     * @returns {Object} - the promise
     */
    async function overwriteAll (newStubs) {
      const stubs = [];
      newStubs.forEach(stub => {
        stubs.push(wrap(stub));
      });
      await reindex(newStubs);
    }

    /**
     * Overwrites the stub at the given index with the new stub
     * @memberOf module:mongoDBImpostersRepository#
     * @param {Object} newStub - the new stub
     * @param {Number} index - the index of the old stuib
     * @returns {Object} - the promise
     */
    async function overwriteAtIndex (newStub, index) {
      const imposter = await get(imposterId);
      const stubs = imposter.stubs;
      if (typeof stubs[index] === 'undefined') {
        throw errors.MissingResourceError(`no stub at index ${index}`);
      }

      stubs[index] = wrap(newStub);
      await reindex(stubs);
    }

    /**
     * Deletes the stub at the given index
     * @memberOf module:mongoDBImpostersRepository#
     * @param {Number} index - the index of the stub to delete
     * @returns {Object} - the promise
     */
    async function deleteAtIndex (index) {
      const imposter = await get(imposterId);
      const stubs = imposter.stubs;
      if (typeof stubs[index] === 'undefined') {
        throw errors.MissingResourceError(`no stub at index ${index}`);
      }

      stubs.splice(index, 1);
      await reindex(stubs);
    }

    /**
     * Returns a JSON-convertible representation
     * @memberOf module:mongoDBImpostersRepository#
     * @param {Object} options - The formatting options
     * @param {Boolean} options.debug - If true, includes debug information
     * @returns {Object} - the promise resolving to the JSON object
     */
    async function toJSON (options = {}) {
      const imposter = await get(imposterId);
      if (!imposter || !imposter.stubs) {
        return [];
      }
      const cloned = JSON.parse(JSON.stringify(imposter.stubs));

      cloned.forEach(stub => {
        if (!options.debug) {
          delete stub.matches;
        }
      });

      return cloned;
    }

    function isRecordedResponse (response) {
      return response.is && typeof response.is._proxyResponseTime === 'number';
    }

    /**
     * Removes the saved proxy responses
     * @memberOf module:mongoDBImpostersRepository#
     * @returns {Object} - Promise
     */
    async function deleteSavedProxyResponses () {
      const allStubs = await toJSON();
      allStubs.forEach(stub => {
        stub.responses = stub.responses.filter(response => !isRecordedResponse(response));
      });
      const nonProxyStubs = allStubs.filter(stub => stub.responses.length > 0);
      await overwriteAll(nonProxyStubs);
    }

    /**
     * Adds a request for the imposter
     * @memberOf module:mongoDBImpostersRepository#
     * @param {Object} request - the request
     * @returns {Object} - the promise
     */
    async function addRequest (request) {
      const helpers = require('./utils/helpers');

      const recordedRequest = helpers.clone(request);
      recordedRequest.timestamp = new Date().toJSON();
      requests.push(recordedRequest);
    }

    /**
     * Returns the saved requests for the imposter
     * @memberOf module:mongoDBImpostersRepository#
     * @returns {Object} - the promise resolving to the array of requests
     */
    async function loadRequests () {
      return requests;
    }

    /**
     * Clears the saved requests list
     * @memberOf module:mongoDBImpostersRepository#
     * @param {Object} request - the request
     * @returns {Object} - Promise
     */
    async function deleteSavedRequests () {
      requests = [];
    }

    function wrap (stub = {}) {
      const cloned = JSON.parse(JSON.stringify(stub)),
        statefulResponses = repeatTransform(cloned.responses || []);

      // carry over stub functions
      Object.keys(stub).forEach(key => {
        if (typeof stub[key] === 'function') {
          cloned[key] = stub[key];
        }
      });

      /**
       * Adds a new response to the stub (e.g. during proxying)
       * @memberOf module:mongoDBImpostersRepository#
       * @param {Object} response - the response to add
       * @returns {Object} - the promise
       */
      cloned.addResponse = async response => {
        const imposter = await get(imposterId);
        cloned.responses = cloned.responses || [];
        cloned.responses.push(response);
        statefulResponses.push(response);
        const stubIndex = imposter.stubs.findIndex(s => JSON.stringify(s) === JSON.stringify(stub));
        if (stubIndex >= 0) {
          imposter.stubs[stubIndex].responses = cloned.responses;
          await update(imposter);
        }
        return response;
      };

      /**
       * Selects the next response from the stub, including repeat behavior and circling back to the beginning
       * @memberOf module:mongoDBImpostersRepository#
       * @returns {Object} - the response
       * @returns {Object} - the promise
       */
      cloned.nextResponse = async () => {
        const responseConfig = statefulResponses.shift();

        if (responseConfig) {
          statefulResponses.push(responseConfig);
          return createResponse(responseConfig, cloned.stubIndex);
        }
        else {
          return createResponse();
        }
      };

      /**
       * Records a match for debugging purposes
       * @memberOf module:mongoDBImpostersRepository#
       * @param {Object} request - the request
       * @param {Object} response - the response
       * @param {Object} responseConfig - the config that generated the response
       * @param {Number} processingTime - the time to match the predicate and generate the full response
       * @returns {Object} - the promise
       */
      cloned.recordMatch = async (request, response, responseConfig, processingTime) => {
        const imposter = await get(imposterId);
        cloned.matches = cloned.matches || [];
        cloned.matches.push({
          timestamp: new Date().toJSON(),
          request,
          response,
          responseConfig,
          processingTime
        });
        const stubIndex = imposter.stubs.findIndex(s => JSON.stringify(s) === JSON.stringify(stub));
        imposter.stubs[stubIndex] = cloned;
        await update(imposter);
      };

      return cloned;
    }

    return {
      count,
      first,
      addAll,
      add,
      insertAtIndex,
      overwriteAll,
      overwriteAtIndex,
      deleteAtIndex,
      toJSON,
      deleteSavedProxyResponses,
      addRequest,
      loadRequests,
      deleteSavedRequests
    };
  }
  return {
    add,
    get,
    all,
    exists,
    del,
    stopAllSync,
    teardown,
    deleteAll,
    stubsFor,
    connect,
    close,
    loadAll
  };
}
async function migrate (config, logger) {
  const mongoCfg = getMongoConfig(config, logger),
    client = new MongoClient(mongoCfg.uri);
  try {
    await client.connect();
    await client.db(mongoCfg.db).createCollection('imposters');
  } finally {
    await client.close();
  }
}

function getMongoConfig (config, logger) {
  if (!config.impostersRepositoryConfig) {
    logger.error('MissingConfigError: No configuration file for mongodb');
    throw errors.MissingConfigError('mongodb configuration required');
  }
  const fs = require('fs'),
    path = require('path'),
    cfg = path.resolve(path.relative(process.cwd(), config.impostersRepositoryConfig));
  if (fs.existsSync(cfg)) {
    return require(cfg);
  } else {
    logger.error('configuration file does not exist');
    throw errors.MissingConfigError('provided config file does not exist');
  }
}
/**
 * An abstraction for loading imposters from in-memory
 * @module
 */

function repeatsFor (response) {
  return response.repeat || 1;
}

function repeatTransform (responses) {
  const result = [];
  let response, repeats;

  for (let i = 0; i < responses.length; i += 1) {
    response = responses[i];
    repeats = repeatsFor(response);
    for (let j = 0; j < repeats; j += 1) {
      result.push(response);
    }
  }
  return result;
}

function createResponse (responseConfig, stubIndexFn) {
  let cloned = { is: {} };
  if (responseConfig) {
    cloned = JSON.parse(JSON.stringify(responseConfig));
  }

  cloned.stubIndex = stubIndexFn ? stubIndexFn : () => Promise.resolve(0);

  return cloned;
}


module.exports = { create, migrate };
