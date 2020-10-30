import { ECS } from 'aws-sdk';
import { ecs, s3, lambda } from '@cumulus/aws-client/services';
import { EnvironmentVariables } from 'aws-sdk/clients/lambda';
import { getDbTransaction, getKnexClient, asyncOperationsConfig } from '@cumulus/db';
import { v4 as uuidv4 } from 'uuid';
import type { AWSError } from 'aws-sdk/lib/error';
import type { PromiseResult } from 'aws-sdk/lib/request';

import { AsyncOperationsDynamoModel } from './types';

const { EcsStartTaskError } = require('@cumulus/errors');

export const getLambdaEnvironmentVariables = async (
  functionName: string
): Promise<EnvironmentVariables[]> => {
  const lambdaConfig = await lambda().getFunctionConfiguration({
    FunctionName: functionName,
  }).promise();

  return Object.entries(lambdaConfig?.Environment?.Variables ?? {}).map((obj) => ({
    name: obj[0],
    value: obj[1],
  }));
};

/**
 * Start an ECS task for the async operation.
 *
 * @param {Object} params
 * @param {string} params.asyncOperationTaskDefinition - ARN for the task definition
 * @param {string} params.cluster - ARN for the ECS cluster to use for the task
 * @param {string} params.lambdaName
 *   Environment variable for Lambda name that will be run by the ECS task
 * @param {string} params.id - the Async operation ID
 * @param {string} params.payloadBucket
 *   S3 bucket name where async operation payload is stored
 * @param {string} params.payloadKey
 *   S3 key name where async operation payload is stored
 * @returns {Promise<Object>}
 * @see https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/ECS.html#runTask-property
 */
export const startECSTask = async ({
  asyncOperationTaskDefinition,
  cluster,
  lambdaName,
  id,
  payloadBucket,
  payloadKey,
  useLambdaEnvironmentVariables,
  dynamoTableName,
}: {
  asyncOperationTaskDefinition: string,
  cluster: string,
  lambdaName: string,
  id: string,
  payloadBucket: string,
  payloadKey: string,
  useLambdaEnvironmentVariables?: string,
  dynamoTableName: string,
}): Promise<PromiseResult<ECS.RunTaskResponse, AWSError>> => {
  const envVars = [
    { name: 'asyncOperationId', value: id },
    { name: 'asyncOperationsTable', value: dynamoTableName },
    { name: 'lambdaName', value: lambdaName },
    { name: 'payloadUrl', value: `s3://${payloadBucket}/${payloadKey}` },
  ] as EnvironmentVariables[];
  let taskVars = envVars;

  if (useLambdaEnvironmentVariables) {
    const lambdaVars = await getLambdaEnvironmentVariables(lambdaName);
    taskVars = envVars.concat(lambdaVars);
  }

  return ecs().runTask({
    cluster,
    taskDefinition: asyncOperationTaskDefinition,
    launchType: 'EC2',
    overrides: {
      containerOverrides: [
        {
          name: 'AsyncOperation',
          environment: taskVars,
        },
      ],
    },
  }).promise();
};

/**
 * Start an AsyncOperation in ECS and store its associate record to DynamoDB
 *
 * @param {Object} params - params
 * @param {string} params.id - the id of the AsyncOperation to start
 * @param {string} params.asyncOperationTaskDefinition - the name or ARN of the
 *   async-operation ECS task definition
 * @param {string} params.cluster - the name of the ECS cluster
 * @param {string} params.lambdaName - the name of the Lambda task to be run
 * @param {Object|Array} params.payload - the event to be passed to the lambda task.
 *   Must be a simple Object or Array which can be converted to JSON.
 * @param {Object} AsyncOperation - A api dynamoDb modeal AsyncOperation object
 * @returns {Promise<Object>} - an AsyncOperation record
 * @memberof AsyncOperation
 */
export const startAsyncOperation = async (params: { // fix input params to match overloaded typing
  description: string,
  operationType: string,
  lambdaName: string,
  cluster: string,
  asyncOperationTaskDefinition: string,
  payload: unknown,
  systemBucket: string,
  stackName: string,
  dynamoTableName: string,
  useLambdaEnvironmentVariables?: string,
  knexConfig?: NodeJS.ProcessEnv,
}, AsyncOperation: new(params: { stackName: string, systemBucket: string, tableName?: string })
  => AsyncOperationsDynamoModel
): Promise<unknown> => { // Update this return typing to match Mark's db typings
  const {
    description,
    operationType,
    payload,
    systemBucket,
    stackName,
    dynamoTableName,
    knexConfig = process.env,
  } = params;

  // Create the record in the database
  const id = uuidv4();

  // Store the payload to S3
  const payloadBucket = systemBucket;
  const payloadKey = `${stackName}/async-operation-payloads/${id}.json`;

  await s3().putObject({
    Bucket: payloadBucket,
    Key: payloadKey,
    Body: JSON.stringify(payload),
  }).promise();

  // Start the task in ECS
  const runTaskResponse = await startECSTask({
    ...params,
    id,
    payloadBucket,
    payloadKey,
  });

  if (runTaskResponse?.failures && runTaskResponse.failures.length > 0) {
    throw new EcsStartTaskError(
      `Failed to start AsyncOperation: ${runTaskResponse.failures[0].reason}`
    );
  }

  const asyncOperationModel = new AsyncOperation({
    stackName,
    systemBucket,
    tableName: dynamoTableName,
  });
  // Create the database record with the taskArn

  const knex = await getKnexClient({ env: knexConfig });
  return knex.transaction(async (trx) => {
    const createObject = {
      id,
      status: 'RUNNING',
      taskArn: runTaskResponse?.tasks ? runTaskResponse.tasks[0].taskArn : undefined,
      description,
      operationType,
    };
    await getDbTransaction(trx, asyncOperationsConfig.name).insert(createObject);
    return asyncOperationModel.create(createObject);
  });
};
