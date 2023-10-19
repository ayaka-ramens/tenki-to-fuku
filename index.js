// AWS　Lambda関数アップロード
// zip function.zip index.js
// aws lambda update-function-code --function-name tenki-to-fuku --zip-file fileb://function.zip

const axios = require("axios");
const dayjs = require("dayjs");
const isBetween = require('dayjs/plugin/isBetween');
dayjs.extend(isBetween);

let Kuroshiro = require('kuroshiro').default;
const KuromojiAnalyzer = require("kuroshiro-analyzer-kuromoji");
let kuroshiroKuromojiCache = null;

const line = require("@line/bot-sdk");
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const lineClient = new line.Client({channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,});

const AWS = require("aws-sdk");
AWS.config.update({region: "ap-northeast-1"});

const dynamoDB = new AWS.DynamoDB();
const WEATHER_API_KEY = process.env.WEATHER_API_KEY;

const HELP_TEXTS = ["help", "HELP", "ヘルプ", "使い方"];

function containsInvalidCharacters(text) {
  // 絵文字・記号を検出
  const invalidCharactersRegex = /[\uD800-\uDFFF\u2000-\u2FFF\u0020-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007E\u3000-\u303F\uFF01-\uFF60\uFF61-\uFF9F]+/g;
  return invalidCharactersRegex.test(text);
}

function isRomanji(str) {
  const romaji_regex = /^[A-Za-z\s]+$/;
  return romaji_regex.test(str);
}

async function initializeKuroshiroKuromoji() {
  if (!kuroshiroKuromojiCache) {
    kuroshiroKuromojiCache = new Kuroshiro();
    const analyzer = await initializeKuromojiAnalyzer();
    await kuroshiroKuromojiCache.init(analyzer);
  }
  return kuroshiroKuromojiCache;
}

async function initializeKuromojiAnalyzer() {
  const analyzer = new KuromojiAnalyzer({ dictPath: '/opt/nodejs/node_modules/kuromoji/dict' });
  return analyzer;
}

async function city_name_convert(text) {
  if (containsInvalidCharacters(text)) {
    throw new Error(`入力値に絵文字や記号が含めないでください\ntext: ${text}`);
  }

  // 入力値がローマ字の場合は早期リターン
  if (isRomanji(text)) { return text; }

  const kuroshiro_kuromoji = await initializeKuroshiroKuromoji();

  try {
    const result = await kuroshiro_kuromoji.convert(text, { to: "romaji", romajiSystem: "passport" });
    console.log("result: kuroshiro convert:", result)
    return result;
  } catch (error) {
    console.error(`入力値のローマ字変換に失敗しました text: ${text}`, error);
    throw new Error(`ローマ字変換失敗\nローマ字入力をお試し下さい\ntext: ${text}`);
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
    console.error(`WeatherAPIのリクエストに失敗しました。入力値: ${weather_api_params}`, error);
    throw new Error(`天気情報の取得\n入力された内容をご確認下さい\ntext: ${weather_api_params}`);
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

    if (clothingData.Items.length === 0) {
      throw new Error("服装マスターなし");
    }
    return clothingData.Items[0].clothing_recommendation.S;
  } catch (error) {
    console.error(`服装マスターの取得に失敗しました。temperature: ${temperature}`, error);
    throw new Error("服装マスター取得失敗");
  }
}

async function generateResponseMessage(forecast) {
  const messages = ["☀️今日の天気と服☁️"];

  for (const hourData of forecast.forecasts) {
    const formattedDate = dayjs(hourData.time).format('MM/DD HH:mm');
    const recommendation = await getClothingRecommendation(hourData.temp_c);
    const message = `
  ${formattedDate}(${hourData.temp_c}°C)
  ${hourData.condition}
  👚${recommendation}👔`;
    messages.push(message);
  }
  return messages.join("\n");
}

async function handleErrorMessage(lineReplyToken, errorMessage) {
  const response = {
    type: "text",
    text: errorMessage
  };

  await lineClient.replyMessage(lineReplyToken, response);
}

exports.handler = async (event) => {
  // LINEからの接続であるか確認
  const signature = event.headers["x-line-signature"];
  const body = JSON.parse(event.body).events[0];
  const lineReplyToken = body.replyToken;

  const bool = line.validateSignature(event.body, LINE_CHANNEL_SECRET, signature);
  if (!bool) {
    await handleErrorMessage(lineReplyToken, "LINEからの接続であるか確認して下さい");
    throw new Error("Invalid signature");
  }

  try {
    let responseText = "";

    if (body.type == "message") {
      if (HELP_TEXTS.includes(body.message.text)) {
        responseText = "☀️使い方☁️\n市・区名を入力してください\n例: shibuya,kamakura,matsumoto"
      } else {
        const city_name = await city_name_convert(body.message.text);
        const weather_api_params = await fetchCityLongitudeLatitude(city_name);
        const forecast = await fetchWeather(weather_api_params);
        responseText = await generateResponseMessage(forecast);
      }
    } else if (body.type === "follow") {
      responseText = "はじめまして😆\n3時間ごとの天気と服装の目安を返します。市区名を入力してください。\n例: shibuya,kamakura,matsumoto";
    } else {
      responseText = "エラー： 未対応のイベントタイプです"
    }

    const response = {
        type: "text",
        text: responseText
    };

    await lineClient.replyMessage(lineReplyToken, response);

    return {
      "isBase64Encoded": false,
      "statusCode": 200,
      "headers": {
        "Content-Type": "application/json"
      },
      "body": "{\"message\": \"Success\"}"
    }
  } catch (error) {
    await handleErrorMessage(lineReplyToken, "エラー： " + error.message);

    return {
      "isBase64Encoded": false,
      "statusCode": 500,
      "headers": {
        "Content-Type": "application/json"
      },
      "body": "{\"error\": \"" + error.message + "\"}"
    }
  }
};
