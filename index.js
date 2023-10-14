// AWS　Lambda関数アップロード
// zip function.zip index.js
// aws lambda update-function-code --function-name tenki-to-fuku --zip-file fileb://function.zip

const axios = require("axios");
const dayjs = require("dayjs");
const isBetween = require('dayjs/plugin/isBetween');
dayjs.extend(isBetween);

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
  const analyzer = new KuromojiAnalyzer({ dictPath: '/opt/nodejs/node_modules/kuromoji/dict' });
  await kuroshiro_kuromoji.init(analyzer);

  try {
    const result = await kuroshiro_kuromoji.convert(text, { to: "romaji", romajiSystem: "passport" });
    console.log("result: kuroshiro convert:", result)
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
    console.log("result: dynamoDB getItem:", result)
    return result.Item.longitude_latitude.S;
  } catch (error) {
    // 経度緯度テーブルに登録がない場合はcity_nameをリクエストパラメータにする
    console.error(`経度緯度の取得に失敗しました。city_name: ${city_name} をパラメーターとして使います`, error);
    return city_name;
  }
}

// 天気情報レスポンスを整形して現在の時刻から12時間後まで範囲のみ返す
async function responseFormat(weather_response) {
  const currentDate = dayjs();
  const dateOfEndpoint = currentDate.add(12, "hour").startOf("hour");
  // 24時間以内のhourデータだけをフィルタリング
  const relevantHours = weather_response.data.forecast.forecastday.flatMap(forecastDay =>
    forecastDay.hour.filter(hourData =>
      dayjs.unix(hourData.time_epoch).isBetween(currentDate, dateOfEndpoint, null, '[]')
    )
  );
  // 3時間毎のデータだけをフィルタリング
  const threeHourIntervals = relevantHours.filter((_, index) => index % 3 === 0);
  // フォーマットしたレスポンス
  const formattedResponse = {
    currentDate: currentDate,
    forecasts: threeHourIntervals.map(hourData => ({
      time: hourData.time,
      condition: hourData.condition.text,
      temp_c: hourData.temp_c
    }))
  };

  return formattedResponse;
}

async function fetchWeather(weather_api_params) {
  const url = `https://api.weatherapi.com/v1/forecast.json?key=${WEATHER_API_KEY}&q=${weather_api_params}&lang=ja&hours=24&days=2&aqi=no&alerts=no`;
  console.log("url: Weather Api get:", url)

  try {
    const response = await axios.get(url);
    console.log("response: Weather Api get:", response)
    return responseFormat(response)
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
    console.log("clothingData:", clothingData);

    if (clothingData.Items.length === 0) {
      throw new Error("服装マスターに該当する服装がありません");
    }
    return clothingData.Items[0].clothing_recommendation.S;
  } catch (error) {
    console.error(`服装マスターの取得に失敗しました。temperature: ${temperature}`, error);
    throw error;
  }
}

async function generateResponseMessage(forecast) {
  console.log("forecast:", forecast);
  const messages = ["👔今日の天気と服👚"];

  for (const hourData of forecast.forecasts) {
    const formattedDate = dayjs(hourData.time).format('MM/DD HH:mm');
    // const recommendation = await getClothingRecommendation(hourData.temp_c);
    const recommendation = 'hoge';
    console.log("recommendation:", recommendation)
    const message = `
    ${formattedDate}(${hourData.temp_c}°C)
    ${hourData.condition}
    ${recommendation}`;
    messages.push(message);
  }
  console.log("messages:", messages)
  return messages.join("\n");
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
  const responseText = await generateResponseMessage(forecast)

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
