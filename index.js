// zip function.zip index.js
// aws lambda update-function-code --function-name tenki-to-fuku --zip-file fileb://function.zip
const axios = require("axios");
const dayjs = require('dayjs');

const line = require('@line/bot-sdk');
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const lineClient = new line.Client({channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,});

const AWS = require("aws-sdk");
AWS.config.update({region: 'ap-northeast-1'});

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
    console.log('=======result=======', result)
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
    console.log('=======response=======', response)
    const currentDate = dayjs();
    // 現在の時刻から24時間後までの天気情報を返す
    const dateOfEndpoint = date.add(24, 'hour').startOf('hour');

    // 24時間以内のhourデータだけをフィルタリング
    const relevantHours = response.data.forecast.forecastday.flatMap(forecastDay =>
      forecastDay.hour.filter(hourData =>
        dayjs.unix(hourData.time_epoch).isBetween(currentDate, dateOfEndpoint)
      )
    );

    // 3時間毎のデータだけをフィルタリング
    const threeHourIntervals = relevantHours.filter((_, index) => index % 3 === 0);

    // フォーマットしたレスポンス
    const formattedResponse = {
      currentDate: currentDate,
      forecasts: threeHourIntervals.map(hourData => ({
        time: hourData.time,
        temp_c: hourData.temp_c
      }))
    };
    console.log('=======formattedResponse=======', formattedResponse)

    return formattedResponse;
  } catch (error) {
    console.error(`WeatherAPIのリクエストに失敗しました。weather_api_params: ${weather_api_params}`, error);
    throw error;
  }
}

async function getClothingRecommendation(temperature) {
  // 服装の目安となるテーブルから該当する服装を取得
  const clothingParams = {
    TableName: "tenki-to-fuku-clothing-recommendation",
    FilterExpression: "(attribute_not_exists(#max_temperature) OR :minTemp <= #max_temperature) AND (attribute_not_exists(#min_temperature) OR :maxTemp >= #min_temperature)",
    ExpressionAttributeNames: {
        "#min_temperature": "min_temperature",
        "#max_temperature": "max_temperature"
    },
    ExpressionAttributeValues: {
        ":minTemp": { N: String(temperature) },
        ":maxTemp": { N: String(temperature) }
    }
  };

  try {
    const clothingData = await dynamoDB.scan(clothingParams).promise();
    console.log('=======clothingData=======', clothingData);

    if (clothingData.Items.length === 0) {
      throw new Error("No matching clothing recommendation found.");
    }

    return clothingData.Items[0];
  } catch (error) {
    console.error(`服装マスターの取得に失敗しました。temperature: ${temperature}`, error);
    throw error;
  }
}

function generateResponseMessage(temperature, recommendation) {
  // const recommendation = await getClothingRecommendation(temperature)
  // 今日の平均気温、3時間毎の気温と服装、服装の説明を返す
  return 'xxxxx'
}

exports.handler = async (event) => {
  // LINEからの接続であるか確認
  const signature = event.headers["x-line-signature"];
  const bool = line.validateSignature(event.body, LINE_CHANNEL_SECRET, signature);
  if (!bool) throw new Error("invalid signature");

  const body = JSON.parse(event.body).events[0];

  const weather_api_params = await fetchCityLongitudeLatitude(body.message.text);
  const forecast = await fetchWeather(weather_api_params)
  const responseText = generateResponseMessage(forecast)

  // LINE MessageAPIへレスポンス
  const response = {
      type: "text",
      text: responseText
  };

  await lineClient.replyMessage(body.replyToken, response);

  // lambdaのエラーにならないようにレスポンスを返す
  return {
    "isBase64Encoded": false,
    "statusCode": 200,
    "headers": {
      "Content-Type": "application/json"
    },
    "body": "{\"message\": \"Hello, World!\"}"
  }
};
