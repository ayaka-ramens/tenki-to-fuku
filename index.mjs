import { DynamoDBDocumentClient, GetCommand} from "@aws-sdk/lib-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

const ddbClient = new DynamoDBClient({ region: "ap-northeast-1" });
const dynamo = DynamoDBDocumentClient.from(ddbClient);

const tableName = "tenki-to-fuku-city";

export const handler = async (event, context) => {
  let body;
  let statusCode = 200;
  const headers = {
    "Content-Type": "application/json",
  };

  try {
    body = await dynamo.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          id: event.pathParameters.id,
        },
      })
    );
    body = body.Item;
  } catch (err) {
    statusCode = 400;
    body = err.message;
  } finally {
    body = JSON.stringify(body);
  }

  return {
    statusCode,
    body,
    headers,
  };
};
