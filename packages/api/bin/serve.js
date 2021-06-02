'use strict';

const pLimit = require('p-limit');
const pRetry = require('p-retry');
const { promiseS3Upload } = require('@cumulus/aws-client/S3');
const { s3, systemsManager } = require('@cumulus/aws-client/services');
const { randomId, inTestMode } = require('@cumulus/common/test-utils');
const {
  AsyncOperationPgModel,
  CollectionPgModel,
  ExecutionPgModel,
  FilePgModel,
  getKnexClient,
  GranulePgModel,
  GranulesExecutionsPgModel,
  PdrPgModel,
  ProviderPgModel,
  RulePgModel,
  localStackConnectionEnv,
  translateApiCollectionToPostgresCollection,
  translateApiProviderToPostgresProvider,
  translateApiRuleToPostgresRule,
  translateApiGranuleToPostgresGranule,
  translateApiExecutionToPostgresExecution,
} = require('@cumulus/db');

const bootstrap = require('../lambdas/bootstrap');
const models = require('../models');
const testUtils = require('../lib/testUtils');
const serveUtils = require('./serveUtils');
const {
  setLocalEsVariables,
  localStackName,
  localSystemBucket,
  localUserName,
  getESClientAndIndex,
} = require('./local-test-defaults');


const workflowList = testUtils.getWorkflowList();

async function createTable(Model, tableName) {
  try {
    const model = new Model({
      tableName,
      stackName: process.env.stackName,
      systemBucket: process.env.system_bucket,
    });
    await model.createTable();
  } catch (error) {
    if (error && error.message && error.message === 'Cannot create preexisting table') {
      console.log(`${tableName} is already created`);
    } else {
      throw error;
    }
  }
}

async function populateBucket(bucket, stackName) {
  // upload workflow files
  const workflowPromises = workflowList.map((obj) => promiseS3Upload({
    Bucket: bucket,
    Key: `${stackName}/workflows/${obj.name}.json`,
    Body: JSON.stringify(obj),
  }));

  // upload workflow template
  const workflow = `${stackName}/workflow_template.json`;
  const templatePromise = promiseS3Upload({
    Bucket: bucket,
    Key: workflow,
    Body: JSON.stringify({}),
  });
  await Promise.all([...workflowPromises, templatePromise]);
}

async function setTableEnvVariables(stackName) {
  process.env.FilesTable = `${stackName}-FilesTable`;

  const tableModels = Object
    .keys(models)
    .filter((tableModel) => tableModel !== 'Manager');

  // generate table names
  const tableMapKeys = tableModels
    .map((tableModel) => `${tableModel}sTable`);

  // set table env variables
  const tableNamesMap = {};
  const tableNames = tableMapKeys.map((tableNameKey) => {
    const tableName = `${stackName}-${tableNameKey}`;
    tableNamesMap[tableNameKey] = tableName;
    process.env[tableNameKey] = tableName;
    return process.env[tableNameKey];
  });

  const dynamoTableNamesParameterName = `${stackName}-dynamo-tables`;
  process.env.dynamoTableNamesParameterName = dynamoTableNamesParameterName;
  await systemsManager().putParameter({
    Name: dynamoTableNamesParameterName,
    Value: JSON.stringify(tableNamesMap),
    Overwrite: true,
  }).promise();

  return {
    tableModels,
    tableNames,
  };
}

// check if the tables and Elasticsearch indices exist
// if not create them
async function checkOrCreateTables(stackName) {
  const tables = await setTableEnvVariables(stackName);
  const limit = pLimit(1);

  let i = -1;
  const promises = tables.tableModels.map((t) => limit(() => {
    i += 1;
    console.log(tables.tableNames[i]);
    return createTable(
      models[t],
      tables.tableNames[i]
    );
  }));
  await Promise.all(promises);
}

async function prepareServices(stackName, bucket) {
  setLocalEsVariables(stackName);
  console.log(process.env.ES_HOST);
  await bootstrap.bootstrapElasticSearch(process.env.ES_HOST, process.env.ES_INDEX);
  await s3().createBucket({ Bucket: bucket }).promise();
}

function getRequiredAuthEnvVariables() {
  const authEnvVariables = process.env.FAKE_AUTH
    ? []
    : ['EARTHDATA_CLIENT_ID', 'EARTHDATA_CLIENT_PASSWORD'];
  return authEnvVariables;
}

function setAuthEnvVariables() {
  if (process.env.FAKE_AUTH) {
    process.env.EARTHDATA_CLIENT_ID = randomId('EARTHDATA_CLIENT_ID');
    process.env.EARTHDATA_CLIENT_PASSWORD = randomId('EARTHDATA_CLIENT_PASSWORD');
    process.env.EARTHDATA_BASE_URL = 'https://example.com';
  }
}

function checkEnvVariablesAreSet(moreRequiredEnvVars) {
  const authEnvVariables = getRequiredAuthEnvVariables();
  const requiredEnvVars = authEnvVariables.concat(moreRequiredEnvVars);
  requiredEnvVars.forEach((env) => {
    if (!process.env[env]) {
      throw new Error(`Environment Variable ${env} is not set!`);
    }
  });
}

/**
 * erases Elasticsearch index
 * @param {any} esClient - Elasticsearch client
 * @param {any} esIndex - index to delete
 */
async function eraseElasticsearchIndices(esClient, esIndex) {
  try {
    await esClient.indices.delete({ index: esIndex });
  } catch (error) {
    if (error.message !== 'index_not_found_exception') throw error;
  }
}

/**
 * resets Elasticsearch and returns the client and index.
 *
 * @param {string} stackName - The name of local stack. Used to prefix stack resources.
 * @returns {Object} - Elasticsearch client and index
 */
async function initializeLocalElasticsearch(stackName) {
  const es = await getESClientAndIndex(stackName);
  await eraseElasticsearchIndices(es.client, es.index);
  return bootstrap.bootstrapElasticSearch(process.env.ES_HOST, es.index);
}

/**
 * Fill dynamo, postgres and elastic with fake records for testing.
 * @param {string} stackName - The name of local stack. Used to prefix stack resources.
 * @param {string} user - username
 */
async function createDBRecords(stackName, user, knex) {
  const asyncOperationPgModel = new AsyncOperationPgModel();
  const collectionPgModel = new CollectionPgModel();
  const executionPgModel = new ExecutionPgModel();
  const filePgModel = new FilePgModel();
  const granulePgModel = new GranulePgModel()
  const granulesExecutionsPgModel = new GranulesExecutionsPgModel();
  const pdrPgModel = new PdrPgModel();
  const providerPgModel = new ProviderPgModel();
  const rulePgModel = new RulePgModel();

  await initializeLocalElasticsearch(stackName);

  if (user) {
    await testUtils.setAuthorizedOAuthUsers([user]);
  }

  // add collection records
  const collection = testUtils.fakeCollectionFactory({
    name: `${stackName}-collection`,
    version: '0.0.0',
  });
  await serveUtils.addCollections([collection]);
  const postgresCollection = await translateApiCollectionToPostgresCollection(collection);
  await collectionPgModel.upsert(knex, postgresCollection);

  // add provider records
  const provider = testUtils.fakeProviderFactory({ id: `${stackName}-provider` });
  await serveUtils.addProviders([provider]);
  const postgresProvider = await translateApiProviderToPostgresProvider(provider);
  providerPgModel.upsert(postgresProvider);

  // add rule records
  const rule = testUtils.fakeRuleFactoryV2({
    name: `${stackName}_rule`,
    workflow: workflowList[0].name,
    provider: `${stackName}-provider`,
    collection: {
      name: `${stackName}-collection`,
      version: '0.0.0',
    },
  });
  await serveUtils.addRules([rule]);
  const postgresRule = translateApiRuleToPostgresRule(rule);
  await rulePgModel.upsert(knex, postgresRule);

  // add granule records
  const granule = testUtils.fakeGranuleFactoryV2({
    granuleId: `${stackName}-granule`,
    collectionId: `${stackName}-collection___0.0.0`,
  });
  await serveUtils.addGranules([granule]);
  const postgresGranule = translateApiGranuleToPostgresGranule(granule);
  const [ pgGranuleCumulusId ] = await granulePgModel.upsert(knex, postgresGranule);

  // add fake execution records
  const execution = testUtils.fakeExecutionFactoryV2({ arn: `${stackName}-fake-arn` });
  await serveUtils.addExecutions([execution]);
  const postgresExecution = translateApiExecutionToPostgresExecution(execution)
  const [ pgExecutionCumulusId ] = await executionPgModel.update(knex, execution);

  // add pdrs records
  const pdr = testUtils.fakePdrFactoryV2({ pdrName: `${stackName}-pdr` });
  await serveUtils.addPdrs([pdr]);
}

/**
 * Prepare and run the Cumulus API Express app.
 *
 * @param {string} user - A username to add as an authorized user for the API.
 * @param {string} stackName - The name of local stack. Used to prefix stack resources.
 * @param {bool} reseed - boolean to control whether to load new data into
 *                        dynamo and elastic search.
 */
async function serveApi(user, stackName = localStackName, reseed = true) {
  const port = process.env.PORT || 5001;
  const requiredEnvVars = [
    'stackName',
    'system_bucket',
    'TOKEN_REDIRECT_ENDPOINT',
    'TOKEN_SECRET',
  ];

  // Set env variable to mark this as a local run of the API
  process.env.CUMULUS_ENV = 'local';

  process.env.API_BASE_URL = `http://localhost:${port}`;
  process.env.TOKEN_REDIRECT_ENDPOINT = `http://localhost:${port}/token`;
  process.env.TOKEN_SECRET = randomId('tokensecret');

  process.env = {
    ...process.env,
    ...localStackConnectionEnv,
  };

  if (inTestMode()) {
    // set env variables
    setAuthEnvVariables();
    process.env.system_bucket = localSystemBucket;
    process.env.stackName = stackName;

    checkEnvVariablesAreSet(requiredEnvVars);

    // create tables if not already created
    await pRetry(
      async () => await checkOrCreateTables(stackName),
      {
        onFailedAttempt: (error) => console.log(
          `Failed to Create Tables. Localstack may not be ready, will retry ${error.attemptsLeft} more times.`
        ),
      }
    );

    await prepareServices(stackName, process.env.system_bucket);
    await populateBucket(process.env.system_bucket, stackName);
    if (reseed) {
      await createDBRecords(stackName, user);
    }
  } else {
    checkEnvVariablesAreSet(requiredEnvVars);
    await setTableEnvVariables(process.env.stackName);
  }

  console.log(`Starting server on port ${port}`);
  const { app } = require('../app'); // eslint-disable-line global-require
  app.listen(port);
}

/**
 * Prepare and run the Cumulus distribution API Express app.
 *
 * @param {string} stackName - The name of local stack. Used to prefix stack resources.
 * @param {function} done - Optional callback to fire when app has started listening.
 */
async function serveDistributionApi(stackName = localStackName, done) {
  const port = process.env.PORT || 5002;
  const requiredEnvVars = [
    'DISTRIBUTION_REDIRECT_ENDPOINT',
    'DISTRIBUTION_ENDPOINT',
  ];

  // Set env variable to mark this as a local run of the API
  process.env.CUMULUS_ENV = 'local';

  // Point distribution API to local
  process.env.DISTRIBUTION_REDIRECT_ENDPOINT = `http://localhost:${port}/redirect`;
  process.env.DISTRIBUTION_ENDPOINT = `http://localhost:${port}`;

  if (inTestMode()) {
    // set env variables
    setAuthEnvVariables();
    process.env.system_bucket = localSystemBucket;

    checkEnvVariablesAreSet(requiredEnvVars);

    // create tables if not already created
    await checkOrCreateTables(stackName);

    await prepareServices(stackName, process.env.system_bucket);
    await populateBucket(process.env.system_bucket, stackName);
    await createDBRecords(stackName);
  } else {
    checkEnvVariablesAreSet(requiredEnvVars);
    await setTableEnvVariables(stackName);
  }

  console.log(`Starting server on port ${port}`);
  const { distributionApp } = require('../app/distribution'); // eslint-disable-line global-require
  return distributionApp.listen(port, done);
}

async function erasePostgresTables(knex) {
  const asyncOperationPgModel = new AsyncOperationPgModel();
  const collectionPgModel = new CollectionPgModel();
  const executionPgModel = new ExecutionPgModel();
  const filePgModel = new FilePgModel();
  const granulePgModel = new GranulePgModel()
  const granulesExecutionsPgModel = new GranulesExecutionsPgModel();
  const pdrPgModel = new PdrPgModel();
  const providerPgModel = new ProviderPgModel();
  const rulePgModel = new RulePgModel();

  const delPromises = [
    asyncOperationPgModel.del(knex),
    collectionPgModel.del(knex),
    executionPgModel.del(knex),
    filePgModel.del(knex),
    granulePgModel.del(knex),
    granulesExecutionsPgModel.del(knex),
    pdrPgModel.del(knex),
    providerPgModel.del(knex),
    rulePgModel.del(knex),
  ];
  await Promise.all(delPromises);
}

/**
 * erase all dynamoDB tables
 * @param {string} stackName - stack name (generally 'localrun')
 * @param {string} systemBucket - system bucket (generally 'localbucket' )
 */
async function eraseDynamoTables(stackName, systemBucket) {
  setTableEnvVariables(stackName);
  process.env.system_bucket = systemBucket;
  process.env.stackName = stackName;

  // Remove all data from tables
  const providerModel = new models.Provider();
  const collectionModel = new models.Collection();
  const rulesModel = new models.Rule();
  const executionModel = new models.Execution();
  const granulesModel = new models.Granule();
  const pdrsModel = new models.Pdr();

  try {
    await rulesModel.deleteRules();
    await Promise.all([
      collectionModel.deleteCollections(),
      providerModel.deleteProviders(),
      executionModel.deleteExecutions(),
      granulesModel.deleteGranules(),
      pdrsModel.deletePdrs(),
    ]);
  } catch (error) {
    console.log(error);
  }
}

/**
 * Erases DynamoDB tables and resets Elasticsearch
 *
 * @param {string} stackName - defaults to local stack, 'localrun'
 * @param {string} systemBucket - defaults to 'localbucket'
 */
async function eraseDataStack(
  stackName = localStackName,
  systemBucket = localSystemBucket
) {
  await eraseDynamoTables(stackName, systemBucket);
  return initializeLocalElasticsearch(stackName);
}

/**
 * Removes all additional data from tables and repopulates with original data.
 *
 * @param {string} user - defaults to local user, testUser
 * @param {string} stackName - defaults to local stack, localrun
 * @param {string} systemBucket - defaults to 'localbucket', localrun
 * @param {bool} runIt - Override check to prevent accidental AWS run.  default: 'false'.
 */
async function resetTables( // Fix api setup.    Ugh.
  user = localUserName,
  stackName = localStackName,
  systemBucket = localSystemBucket,
  runIt = false
) {
  if (inTestMode() || runIt) {
    const knex = await getKnexClient({ env: { ...localStackConnectionEnv, ...process.env } });

    // TODO - is this *really* running against a remote stack?
    // We can't delete databases this way.....
    // do we need to invoke lambda?
    await eraseDynamoTables(stackName, systemBucket);
    await erasePostgresTables(knex);
    // TODO erase and reset postgres DB?
    // Populate tables with original test data (localstack)
    if (inTestMode()) {
      await createDBRecords(stackName, user, knex);
    }
  }
}

module.exports = {
  eraseDataStack,
  serveApi,
  serveDistributionApi,
  resetTables,
};
