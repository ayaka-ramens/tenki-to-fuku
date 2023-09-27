// zip function.zip index.js
// aws lambda update-function-code --function-name tenki-to-fuku --zip-file fileb://function.zip

const line = require('@line/bot-sdk');
const lineClient = new line.Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

const AWS = require("aws-sdk");
AWS.config.update({region: 'ap-northeast-1'});

const axios = require("axios");

const dynamoDB = new AWS.DynamoDB();
const WEATHER_API_KEY = process.env.WEATHER_API_KEY;

async function fetchCityLongitudeLatitude(city_name) {
  // DynamoDBから経度・緯度を取得
  const params = {
    TableName: "tenki-to-fuku-city",
    Key: {
        "id": { S: city_name }
    }
  };

  try {
    const result = await dynamoDB.getItem(params).promise();
    return result.Item.longitude_latitude.S;
  } catch (error) {
    console.error(`経度緯度の取得に失敗しました。city_name: ${city_name} をパラメーターとして使います`, error);
    return city_name;
  }
}

async function fetchWeather(weather_api_params) {
  const url = `https://api.weatherapi.com/v1/forecast.json?key=${WEATHER_API_KEY}&q=${weather_api_params}&lang=ja&hours=24&days=2&aqi=no&alerts=no`;
  // とりあえず平均気温を取得
  // TODO: 3時間毎の気温を取得したい（リクエスト時刻から24時間後まで）
  try {
      const response = await axios.get(url);
      return response.data.forecast.forecastday[0].day.avgtemp_c
  } catch (error) {
      console.error('Error fetching from API:', error);
      throw error;
  }
}

async function getClothingRecommendation(todayTemperature) {
    // 服装の目安となるテーブルから該当する服装を取得
    const clothingParams = {
      TableName: "tenki-to-fuku-clothing-recommendation",
      FilterExpression: ":minTemp <= #temperature AND :maxTemp >= #temperature",
      ExpressionAttributeNames: {
          "#temperature": "min_temperature"
      },
      ExpressionAttributeValues: {
          ":minTemp": { N: String(todayTemperature) },
          ":maxTemp": { N: String(todayTemperature) }
      }
  };
  const clothingData = await dynamoDB.scan(clothingParams).promise();
  return clothingData.Items[0];
}

exports.handler = async (event) => {
  console.log('=======event.bodyだよ========', event)

  // const body = JSON.parse(event.body).events[0];
  // LINEからの接続であるか確認
  // const signature = req.headers["x-line-signature"];
  // const bool = line.validateSignature(req.body, channelSecret, signature);
  // if (!bool) throw new Error("invalid signature");
/*
  const weather_api_params = await fetchCityLongitudeLatitude(body.message);
  const todayTemperature = fetchWeather(weather_api_params)
  const recommendation = getClothingRecommendation(todayTemperature)

  // LINE MessageAPI用のレスポンス
  const response = {
      type: "text",
      text: `今日の気温は約${todayTemperature}℃です。${recommendation.clothing_recommendation.S}がおすすめです。詳細: ${recommendation.description.S}`
  };
*/
const response = {
                    "isBase64Encoded": false,
                    "statusCode": 200,
                    "headers": {
                        "Content-Type": "application/json"
                    },
                    "body": "{\"message\": \"Hello, World!\"}"
                  }
  return response
  // await lineClient.replyMessage(body.replyToken, response);
};