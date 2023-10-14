// AWS　Lambda関数アップロード
// zip function.zip index.js
// aws lambda update-function-code --function-name tenki-to-fuku --zip-file fileb://function.zip

const axios = require("axios");
const dayjs = require("dayjs");

let Kuroshiro = require('kuroshiro').default;
const KuromojiAnalyzer = require("kuroshiro-analyzer-kuromoji");

const line = require("@line/bot-sdk");
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const lineClient = new line.Client({channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,});

const AWS = require("aws-sdk");
AWS.config.update({region: "ap-northeast-1"});

const dynamoDB = new AWS.DynamoDB();
const WEATHER_API_KEY = process.env.WEATHER_API_KEY;

function isRomanji(str) {
  const romaji_regex = /^[A-Za-z\s]+$/;
  return romaji_regex.test(str);
}

async function city_name_convert(text) {
  // 入力値がローマ字の場合は早期リターン
  if (isRomanji(text)) { return text; }
  const kuroshiro_kuromoji = new Kuroshiro();

  try {
    const analyzer = new KuromojiAnalyzer({ dictPath: '/opt/nodejs/node_modules/kuromoji/dict' });
    console.log('analyzer===', analyzer);
    await kuroshiro_kuromoji.init(analyzer);
    console.log('kuroshiro_kuromoji===', kuroshiro_kuromoji);
  } catch (error) {
    console.error("===Error initializing kuroshiro:", error);
  }

  try {
    const result = await kuroshiro_kuromoji.convert(text, { to: "romaji", romajiSystem: "hepburn" });
    console.log("=======result: kuroshiro convert=======", result)
    return result;
  } catch (error) {
    console.error(`入力値のローマ字変換に失敗しました text: ${text}`, error);
    throw error;
  }
}

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
    console.log("=======result: dynamoDB getItem=======", result)
    return result.Item.longitude_latitude.S;
  } catch (error) {
    // 経度緯度テーブルに登録がない場合はcity_nameをリクエストパラメータにする
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
    console.log("=======response: Weather Api get=======", response)
    const currentDate = dayjs();
    // 現在の時刻から24時間後までの天気情報を返す
    const dateOfEndpoint = date.add(24, "hour").startOf("hour");

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
    console.log("=======formattedResponse=======", formattedResponse)

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
    console.log("=======clothingData=======", clothingData);

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
  return `temperature: ${temperature}, recommendation: ${recommendation}`;
}

exports.handler = async (event) => {
  // LINEからの接続であるか確認
  const signature = event.headers["x-line-signature"];
  const bool = line.validateSignature(event.body, LINE_CHANNEL_SECRET, signature);
  if (!bool) throw new Error("invalid signature");

  const body = JSON.parse(event.body).events[0];

  const city_name = await city_name_convert(body.message.text);
  const weather_api_params = await fetchCityLongitudeLatitude(city_name);
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
