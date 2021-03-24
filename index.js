if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}
const bodyParser = require("body-parser");
const axios = require("axios");
const qs = require("qs");
var he = require("he");
const express = require("express");
const port = process.env.PORT;
const app = express();

const { createEventAdapter } = require("@slack/events-api");
const { createMessageAdapter } = require("@slack/interactive-messages");
const slackEvents = createEventAdapter(process.env.SLACK_SIGNING_SECRET);
const slackInteractions = createMessageAdapter(
  process.env.SLACK_SIGNING_SECRET
);
const { WebClient } = require("@slack/web-api");
const token = process.env.SLACK_BOT_TOKEN;
const web = new WebClient(token);

app.use("/events", slackEvents.requestListener());

/* slackEvents.on("app_mention", (event) => {
  console.log(
    `Received an app_mention event from user ${event.user} in channel ${event.channel}`
  );
}); */

slackEvents.on("message", async (event) => {
  await checkActions(event);
});

// All errors in listeners are caught here. If this weren't caught, the program would terminate.
slackEvents.on("error", (error) => {
  console.log(`error: ${error}`);
});

app.use("/interactions", slackInteractions.requestListener());

slackInteractions.action({ type: "button" }, async (payload, respond) => {
  logMsg("Incoming Interaction:", payload);

  if (payload && payload.type) {
    await checkActions(payload);
  }
  if (payload && payload.payload) {
    const interactiveMessage = JSON.parse(payload.payload);
    await checkActions(interactiveMessage);
  }
});

const rawBodyBuffer = (req, res, buf, encoding) => {
  if (buf && buf.length) {
    req.rawBody = buf.toString(encoding || "utf8");
  }
};

app.use(bodyParser.urlencoded({ verify: rawBodyBuffer, extended: true }));
app.use(bodyParser.json({ verify: rawBodyBuffer }));

app.listen(port, function () {
  console.log(`Listening on ${port}`);
});

var params = {};
const QUESTION_TIME = 15000; // 15 Seconds - 15.000 ms

var quiz = {
  rounds: [],
};
var curRound = 0;
var curQuestion = 0;
var round;
var question;
var channel;

var timer;

async function updateMessage(message, ts, params) {
  const CHID = channel && channel.id ? channel.id : channel;
  try {
    await web.chat.update({
      channel: CHID,
      ts: ts,
      text: message,
      ...params,
    });
  } catch (error) {
    console.log(error);
  }
}

async function postMessage(message, params) {
  const CHID = channel && channel.id ? channel.id : channel;

  try {
    await web.chat.postMessage({
      channel: CHID,
      text: message,
      ...params,
    });
  } catch (error) {
    console.log(error);
  }
}

async function postMessageEphemeral(userId, message, params) {
  const CHID = channel && channel.id ? channel.id : channel;

  try {
    await web.chat.postEphemeral({
      channel: CHID,
      user: userId,
      text: message,
      ...params,
    });
  } catch (error) {
    console.log(error);
  }
}

async function checkActions(payload) {
  if (payload && payload.channel && (!channel || channel === "")) {
    channel = payload.channel;
    logMsg("CHANNEL state", channel);
  }

  logMsg("Incoming MSG:", payload.text);

  if (payload.text && payload.text.match(/<(.*)> score/gi)) {
    await postScore();
  } else if (payload.text && payload.text.match(/<(.*)> total/gi)) {
    await totalScore();
  } else if (payload.text && payload.text.match(/<(.*)> play \d{1,5}/gi)) {
    // PLAY

    var count = 5;
    logMsg("PLAY", payload.ts);
    var filter = payload.text.match(/(?<=play )([0-9]*)/gi);
    if (parseInt(filter)) {
      count = parseInt(filter);
    }
    logMsg("COUNT", count);

    const cat = randomIntFromInterval(10, 22);
    //console.log("CAT", cat);

    const questions = await getQuestions(count, "medium", `${cat}`);
    //console.log("Q", questions);
    if (questions) {
      questions[curQuestion]["active"] = true;
      quiz.rounds.push({
        round: curRound,
        questions: questions,
        users: [],
        active: true,
      });
      await askQuestion();
    } else {
      postMessage("API Down mate", params);
    }
  } else {
    // BOT: Start question
    console.log("bot_message", payload.subtype);
    if (payload.subtype === "bot_message" && payload.username === "Erik") {
      if (payload.text && payload.text.startsWith("Q:")) {
        question["ts"] = payload.ts;
        await startTimer();
      }
    }
    // IM - BUTTON
    if (payload.type === "interactive_message") {
      // console.log("IM - ", payload);

      if (!question["participations"]) {
        question["participations"] = [];
      }

      var imAnswer = he.decode(payload.actions[0].value).toLowerCase();
      var correctAnswer = he.decode(question.correct_answer).toLowerCase();

      if (question["participations"].includes(payload.user.id)) {
        logMsg(`USER: ${payload.user.id} has already answerred`);
        postMessageEphemeral(
          payload.user.id,
          `You've already answered! 1 try each`,
          params
        );
      } else {
        question["participations"].push(payload.user.id);

        if (imAnswer === correctAnswer) {
          logMsg(
            `CORRECT ANSWER: ${payload.user.id} - ${payload.actions[0].value}`
          );

          clearInterval(timer);
          question["active"] = false;
          question["winner"] = payload.user.id;

          //var userRes = await axios.get(`https://slack.com/api/users.info?token=${token}&user=${payload.user.id}`)
          var message = `Correct answer from <@${payload.user.id}> (+1) - Answer: *${payload.actions[0].value}*`;
          addPoint(payload.user.id);

          var okParams = {
            ...params,
            attachments: [],
          };
          await updateMessage(message, question["ts"], okParams);
          await nextQuestion();
        } else {
          logMsg(
            `INCORRECT ANSWER: ${payload.user.id} - ${payload.actions[0].value}`
          );
          postMessageEphemeral(payload.user.id, `Incorrect!`, params);
        }
      }
    }
  }
}

async function getQuestions(amount, difficulty, category) {
  var res = await axios.get(
    `https://opentdb.com/api.php?amount=${amount}&category=${category}&difficulty=${difficulty}&type=multiple`
  );
  return res.data.results;
}

async function askQuestion() {
  round = quiz.rounds.find((round) => round.active === true);
  question = round.questions.find((q) => q.active === true);

  logMsg("Active question: ", question.question);
  logMsg("ANSWER: ", question.correct_answer);

  question["endTime"] = new Date().getTime() + QUESTION_TIME;
  question["options"] = mapOptions(question);
  question["print"] = `${question.question}`;

  logMsg("endTime", question["endTime"]);

  question["qParams"] = {
    channel: channel,
    icon_emoji: ":jerre:",
    text: `Q: ${he.decode(question["print"])}`,
    attachments: [
      {
        text: "Select one",
        callback_id: "wopr_game",
        color: "#3AA3E3",
        attachment_type: "default",
        actions: question["options"],
      },
    ],
  };
  await postMessage(`Q: ${question["print"]}`, question["qParams"]);
}

async function nextQuestion() {
  logMsg("Next: ");
  timer && clearInterval(timer);
  //round = quiz.rounds.find((round) => round.active === true);
  curQuestion++;
  if (round) {
    if (round.questions[curQuestion]) {
      logMsg("Next question: ", round.questions[curQuestion]);
      round.questions[curQuestion]["active"] = true;
      await askQuestion();
    } else {
      round["active"] = false;
      await postMessage("Het is gebeurd!", params);
      await postScore();
      curRound++;
      curQuestion = 0;
    }
  }
}

async function totalScore() {
  let userStr = `*scores*: \n`;
  for (let r of quiz.rounds) {
    userStr += `_round_: ${r.id}`;
    if (r) {
      var sortedUsers = r.users.sort((u1, u2) => u2.score - u1.score);
      for (let u of sortedUsers) {
        userStr += `\t_<@${u.id}>_ : *${u.score}* \n`;
      }
    }
  }
  await postMessage(`${userStr}`, params);
}
async function postScore() {
  let userStr = `*scores*: \n`;
  if (round) {
    var sortedUsers = round.users.sort((u1, u2) => u2.score - u1.score);
    for (let u of sortedUsers) {
      userStr += `\t_<@${u.id}>_ : *${u.score}* \n`;
    }
    await postMessage(`${userStr}`, params);
  }
}

function mapOptions(question) {
  var options = [...question.incorrect_answers, question.correct_answer];
  shuffleArray(options);
  return options.map((opt) => {
    return {
      name: he.decode(opt),
      text: he.decode(opt),
      type: "button",
      style: "primary",
      value: he.decode(opt),
    };
  });
}

async function startTimer() {
  if (round && question) {
    timer = setInterval(async () => {
      logMsg("interval");
      let now = new Date().getTime();
      let t = question["endTime"] - now;

      if (t >= 0) {
        //console.log("time", t);
        let secs = Math.floor((t % (1000 * 60)) / 1000);
        /* var okParams = {
                      ...params,
                      attachments: question["qParams"] ? question["qParams"].attachments : [],
                  } */

        if (t >= 4000 && t <= 5000) {
          postMessage("5 secs left", params);
        }
        //await updateMessage(`Q: ${question.question} - ${("0" + secs).slice(-2)} sec`, payload.ts, okParams);
      } else {
        var okParams = {
          ...params,
          attachments: [],
        };
        if (question && !question["winner"]) {
          logMsg("NO WINNER - TIME IS UP");
          updateMessage(
            `Time is up - Q: ${he.decode(question.question)} - A: *${he.decode(
              question.correct_answer
            )}*`,
            question["ts"],
            okParams
          );

          question["active"] = false;

          if (round && round["active"]) {
            logMsg("ACTIVE ROUND", round.id);
            clearInterval(timer);
            nextQuestion();
          }
        }
      }
    }, 1000);
  }
}

function addPoint(userId) {
  const index = round.users.findIndex((u) => u.id === userId);
  if (index > -1) {
    round.users[index].score = round.users[index].score + 1;
  } else {
    round.users.push({
      id: userId,
      score: 1,
    });
  }
}

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

function logMsg(msg, data = "") {
  console.log(msg, data);
}

function randomIntFromInterval(min, max) {
  // min and max included
  return Math.floor(Math.random() * (max - min + 1) + min);
}
