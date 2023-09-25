console.log('Loading function');

import { DynamoDBDocumentClient, GetCommand} from "@aws-sdk/lib-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

const ddbClient = new DynamoDBClient({ region: "ap-northeast-1" });
const ddbDocClient = DynamoDBDocumentClient.from(ddbClient);

const tablename = "tenki-to-fuku";

export const handler = async (event, context) => {

  const operation = event.operation;

  if (operation == 'echo'){
    return(event.payload);
  }
  else {
    event.payload.TableName = tablename;

    if (operation == 'create') {
      var table_item = await ddbDocClient.send(new GetCommand(event.payload));
      console.log(table_item);
    }
    else {
      return (`Unknown operation: ${operation}`);
    }
  }
};

/*
以下の invoke AWS CLI コマンドを実行すると、定義した関数を呼び出すことができます

aws lambda invoke --function-name LambdaFunctionOverHttps \
--payload file://lambda_echo_input.txt lambda_echo_output.txt --cli-binary-format raw-in-base64-out
*/
