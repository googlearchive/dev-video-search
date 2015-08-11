/*

Copyright 2015 Google Inc. All rights reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

*/

'use strict';

var API_KEY = 'AIzaSyCtc9Z2prdQd40CZ6PlH004wLscSOKJ80w';

var google = require('googleapis');
google.options({
  auth: API_KEY,
  userId: 'dutton@google.com'
});

var youtube = google.youtube('v3');
var MAXRESULTS = 50; // for YouTube Data API requests
var FUDGEFACTOR = 20; // see below: YouTube Data API totalResuls is an estimate :(

var moment = require('moment');
var request = require('request');

var account = 'samdutton';
var password = process.env.cloudant;
var dbName = 'shearch';
var cloudantUrl = 'https://' + account + ':' + password + '@' + account +
  '.cloudant.com/';
var dbUrl = cloudantUrl + dbName;
var dbStagingUrl = dbUrl + '-staging';

var allSpeakers;
var videos;
var numVideoIds;
var numVideosInserted;
var numTranscripts;
var numTranscriptRetrieved;
var speakers;

var numIdRetrieved;
var numDataRetrieved;

var timer;

var urlRegex =
  /(https?:\/\/(?:www\.|(?!www))[^\s\.]+\.[\w]{2,}(\.\w+)*(\/[\w]+)*(\.\w+)?\/?|www\.[^\s]+\.[^\s]{2,})/gm;

process.on('beforeExit', function() {
  console.log('video IDs, videos inserted: ' + numVideoIds, numVideosInserted);
  if (numVideoIds === numVideosInserted) {
    console.log('>>>>> begin replicating database');
  } else {
    // start again
    console.log('>>>>> start again');
    //    main();
  }
});

// TODO: something more robust
// process.on('uncaughtException', function(error) {
//   console.log('Restarting, caught exception: ' + error);
//   main();
// });

main();

function main() {
  timer = process.hrtime();

  allSpeakers = [];
  videos = [];
  numVideoIds = 0;
  numVideosInserted = 0;
  numTranscripts = 0;
  numIdRetrieved = 0;
  numDataRetrieved = 0;
  numTranscriptRetrieved = 0;

  request.del(dbStagingUrl, function(error, response, body) {
    if (!error && response.statusCode === 200) {
      console.log('Successfully deleted database: ' + body);
      request.put(dbStagingUrl, function(error, response, body) {
        if (!error && response.statusCode === 201) {
          console.log('Successfully created database: ' + body);
          insertDesignDoc();
          getVideoIds(); // starts process of getting video data and captions
        } else {
          console.log('Error creating database: ', error, response);
        }
      });
    } else {
      console.log('Error deleting database ' + dbName + '-staging: ', error);
    }
  });
}

function insertDesignDoc() {
  var fs = require('fs');
  var designDocUrl = dbStagingUrl + '/_design/videos';
  var filePath = 'design.json';
  fs.createReadStream(filePath).pipe(request.put(designDocUrl, {},
    function(error, response, body) {
      if (error) {
        console.log('Error uploading design doc: ',
          error, body, response.substring(0, 100));
      } else if (body !== '') {
        console.log('Successfully uploaded design doc: ', body);
      }
    }));
}

// Get video IDs for all playlists with getPlayListItems()
function getVideoIds() {
  var androidDevelopers = 'UUVHFbqXqoYvEWM1Ddxl0QDg ';
  var chromeDevelopers = 'UUnUYZLuoy1rq1aVMwx4aTzw';
  var googleDevelopers = 'UU_x5XG1OV2P6uZZ5FSM9Ttw';
  var playlistIds = [androidDevelopers, chromeDevelopers, googleDevelopers];
  for (var i = 0; i !== playlistIds.length; ++i) {
    var params = {
      maxResults: MAXRESULTS,
      part: 'contentDetails ',
      playlistId: playlistIds[i]
    };
    // Get video IDs for all channels in batches of 50 (or whatever MAXRESULTS is)
    getPlaylistItems(params);
  }
}

// Get playlist items (only for video IDs)
function getPlaylistItems(params) {
  youtube.playlistItems.list(params, function(error, data) {
    handlePlaylistItemData(error, data, params);
  });
}

// Handle video IDs: get video data in batches
function handlePlaylistItemData(error, data, params) {
  if (error) {
    console.error('Re-getting video IDs following error: ' +
      JSON.stringify(error));
    // TODO: limit number of retries
    //    setTimeout(function() {
    getPlaylistItems(params);
    //    }, 1000);
    return;
  }

  // if first page, add totalResults to numVideoIds
  // NB: totalResults is only an estimate :(
  if (!data.prevPageToken) {
    // totalResults is only an estimate :(
    numVideoIds += data.pageInfo.totalResults;
    console.log('>>>> Estimated ' + numVideoIds +
      ' video IDs including playlist ' + params.playlistId);
  }

  numIdRetrieved += data.items.length;
  console.log('>>>> Video IDs retrieved: ' + numIdRetrieved);

  var videoIds = [];
  for (var i = 0; i !== data.items.length; ++i) {
    videoIds.push(data.items[i].contentDetails.videoId);
  }

  if (data.nextPageToken) {
    params.pageToken = data.nextPageToken;
    getPlaylistItems(params);
  } else {
    console.log('>>>> Completed getting video IDs for playlist ' +
      params.playlistId);
  }

  setTimeout(function() { // ensure all playlists have been retrieved
    getVideoData(videoIds.join(','));
  }, 1000);
}

// Get data for a batch of videos (passed as a string of comma-separated video IDs)
function getVideoData(videoIds) {
  var params = {
    id: videoIds,
    maxResults: MAXRESULTS,
    part: 'snippet,statistics,contentDetails'
  };
  youtube.videos.list(params, function(error, data) {
    handleVideoData(error, data, params);
  });
}

// Handle a batch of video data: snippets, statistics, contentDetails
function handleVideoData(error, data, params) {
  if (error) {
    console.error('Re-getting video data following error: ' +
      JSON.stringify(error));
    setTimeout(function() {
      youtube.videos.list(params, function(error, data) {
        handleVideoData(error, data, params);
      });
    }, 1000);
    return;
  }
  for (var i = 0; i !== data.items.length; ++i) {
    var item = data.items[i];
    var snippet = item.snippet;
    var id = item.id;
    var video = {
      id: id, // to simplify eventual conversion of videos object to an array
      title: tweakText(snippet.title),
      description: tweakText(snippet.description),
      speakers: [],
      publishedAt: snippet.publishedAt,
      publishedAtUnix: Date.parse(snippet.publishedAt), // for ranges
      channelId: snippet.channelId,
      channelTitle: snippet.channelTitle,
      thumbnails: snippet.thumbnails,
    };
    for (var prop in item.statistics) {
      video[prop] = item.statistics[prop];
    }
    for (prop in item.contentDetails) {
      video[prop] = item.contentDetails[prop];
    }

    video.durationSeconds = moment.duration(video.duration).
      asSeconds().toString();

    if (video.caption === 'true') {
      numTranscripts += 1;
    }

    videos.push(video);
  }

  numDataRetrieved += data.items.length;
  console.log('>>>>> Videos with data retrieved: ' + numDataRetrieved);

  // YouTube Data API totalResults is estimate :^(
  // FUDGEFACTOR is less than the number in a batch, so this should work
  // TODO: something better
  if (videos.length > numVideoIds - FUDGEFACTOR) {
    console.log('Got data for ' + videos.length + ' videos in ' +
      elapsed() + ' seconds');
    getTranscript(videos.length - 1);
  }
}

// Get transcript synchronously to avoid socket errors
// TODO: get permission to get transcripts via official API
function getTranscript(index, useAlternativeUrl) {
  if (index < 0) {
    return;
    // if no transcript for this video, move onto the next
  } else if (videos[index].caption !== 'true') {
    getTranscript(--index);
  } else {
    var transcriptUrl = 'https://www.youtube.com/api/timedtext?v=' +
      videos[index].id + '&lang=en'; // unofficial API
    // some transcripts are only available if &name=CC is added to the URL :^\
    if (useAlternativeUrl) {
      transcriptUrl += '&name=CC';
    }
    request({
      uri: transcriptUrl,
      timeout: 5000, // getting captions via unofficial API intermittently fails :(
    }, function(error, response, body) {
      handleTranscript(error, response, body, index, transcriptUrl);
    }) /*.end()*/ ;
  }
}

function handleTranscript(error, response, body, index, transcriptUrl) { // jshint ignore:line
  var video = videos[index];
  if (error /* || (response && response.statusCode !== 200) */) {
    console.log('Retrying to get transcript for ' +
      video.id + ' following error: ' + error);
    // TODO: limit retries
    getTranscript(index);
    return;
  } else if (body === '') { // some are empty
    console.log('Empty transcript for ' + video.id);
    // try alternative URL
    // some transcripts are only available if &name=CC is added to the URL :^\
    if (transcriptUrl.indexOf('name=CC') === -1) {
      console.log('Trying with alternative URL for ' + video.id);
      getTranscript(index, true);
    } else { // definitely no transcript available
      numTranscriptRetrieved += 1;
      getTranscript(index - 1);
    }
  } else { // got transcript!
    // speakers are added in tweakTranscriptText()
    if (transcriptUrl.indexOf('name=CC') === -1) {
      console.log('Got transcript with alternative URL for ' + video.id);
    }
    speakers = video.speakers = [];
    body = tweakTranscriptText(body);
    // TODO: replace with positive lookahead regex
    video.captions = body.replace(/<\/span><span/gm,
      '</span>@£$<span').split('@£$');
    video.transcript = buildTranscript(body);
    numTranscriptRetrieved += 1;
    console.log('>>>>> numTranscriptRetrieved: ' + numTranscriptRetrieved);
    getTranscript(index - 1);
  }

  if (numTranscriptRetrieved === numTranscripts) {
    console.log('Retrieved all ' + numTranscripts + ' transcripts');
    insertVideos();
  }
}

function tweakTranscriptText(body) {
  return body.
  replace(/<text[^\/]+>\s*<\/text>/gm, ''). // remove empty captions
  replace(/\n/gm, ' ').
  replace(/>>> /gm, 'Audience member: ').
  replace(/&gt;&gt; ?/gm, '').
  replace(/&amp;gt;&amp;gt; ?/gm, '').
  replace(/&amp;gt; ?/gm, '').
  replace(/AUDIENCE/, 'Audience').
  replace(/AUDIENCE MEMBER/, 'Audience member').
  replace(/^>+/gm, '').
  replace(/&#39;/gm, '\'').
  replace(/&amp;#39;/gm, '\'').
  replace(/&quot;/gm, '\'').
  replace(/&amp;quot;/gm, '\'').
  replace('<?xml version="1.0" encoding="utf-8" ?><transcript>', '').
  replace('</transcript>', '').
  replace(/ dur="[^"]+"/gm, '').
  replace(/<text start/gm, '<span data-start').
  replace(/<\/text>/gm, ' </span>'). // add a space at end of each span
  replace(/--/gm, ' &mdash; ').
  replace(/ - /gm, ' &mdash; ').
  replace(/\\r\\n/gm, '<br>').
  replace(/\\n/gm, '<br>').
  replace(/\s{2,}/gm, ' ').
  replace(
    /">(([A-Z][A-Za-z\-]+)|([A-Z][A-Za-z\-]+ [A-Z][A-Za-z\-]+)|([A-Z\-]+\s?[A-Z-]*)):/gm,
    handleSpeakerMatch); // build array of speakers
}

function handleSpeakerMatch(match, submatch1) { // jshint ignore:line
  // correct and capitalize speaker names (Fred Nerk not FRED NERK)
  var speaker = tweakName(submatch1);
  if (speakers.indexOf(speaker) === -1 && isSpeakerAllowed(speaker)) {
    allSpeakers.push(speaker);
    speakers.push(speaker);
  }
  // need to include "> found in replace() regex match
  return '"><span class="speaker">' + speaker + '</span>:';
}

function buildTranscript(transcript) {
  // for each new speaker, start a new paragraph
  // add @$* string to enable paragraphs to be split into an array below
  transcript = transcript.replace(/><span([^\/]+)<span class="speaker">/gm,
    '>@£$<span$1<span class="speaker">');

  // split into array of paragraphs
  // if there are no speaker spans, the array will have one long paragraph
  var paras = transcript.split('@£$');

  // split long paragraphs into shorter paragraphs to make them more readable
  var okParas = [];
  for (var i = 0; i !== paras.length; ++i) {
    var para = paras[i];
    var MAXLENGTH = 1000 + Math.floor(Math.random() * 2000);
    if (para.length < MAXLENGTH) {
      okParas.push(para);
    } else {
      okParas = okParas.concat(split(para, MAXLENGTH));
    }
  }
  return okParas.map(addParagraphTags).join('');
}

function split(para, MAXLENGTH) {
  // split after the end of each sentence
  // each sentence ends with a full stop and space followed by a span closing tag
  var sentences = para.replace(/\. <\/span>/g, '. </span>%^&*').split('%^&*');
  var paras = [];
  var tempPara = '';
  while (sentences.length > 0) {
    tempPara += sentences.shift() + ' ';
    if (tempPara.length > MAXLENGTH) {
      MAXLENGTH = 1000 + Math.floor(Math.random() * 2000); // reset
      paras.push(tempPara);
      tempPara = '';
    }
  }
  paras.push(tempPara); // the last one, not over-length
  return paras;
}

function addParagraphTags(item) {
  // add speaker class to paragraphs that introduces a speaker
  // if (item.indexOf('<span class=\"speaker\">') !== -1) {
  if (item.indexOf('<span class') !== -1) {
    return '<p class="speaker">' + item.trim() + '</p>';
  } else {
    return '<p>' + item.trim() + '</p>';
  }
}

function insertVideos() {
  var NUMTOINSERT = 100;

  for (var begin = 0; begin < videos.length; begin += NUMTOINSERT) {
    console.log('>>>>> begin: ' + begin);
    var requestBody = {
      'docs': videos.slice(begin, begin + NUMTOINSERT)
    };
    var options = {
      uri: dbStagingUrl + '/_bulk_docs',
      body: requestBody,
      json: true,
      method: 'POST',
      // pool: {
      //   maxSockets: 25
      // }
    };
    requestInsert(options);
  }
}

function requestInsert(options) {
  request(options, function(error, response, body) {
    handleBulkInsert(error, response, body, options);
  });
}

function handleBulkInsert(error, response, body, options) { // jshint ignore:line
  if (error || !body.length) {
    console.log('Bulk insert error: ', error);
    if (body) {
      console.log(body.error, body.reason);
    }
    setTimeout(function() {
      request(options, function(error, response, body) {
        handleBulkInsert(error, response, body, options);
      });
    }, 1000);
    return;
  }

  numVideosInserted += body.length;
  if (numVideosInserted === numVideoIds) {
    var beep = require('beepbeep');
    beep(3, 1000);
    console.log('Complete: inserted ' + numVideoIds + ' videos in ' +
      elapsed() + ' seconds');
    console.log('>>>>> allSpeakers:\n\n' + allSpeakers);
  } else {
    console.log(numVideosInserted + ' inserted so far');
  }

}

// Utility functions ///////////////////////////////

function tweakName(name) {
  name = capitalize(name);
  return name.replace('^Wiltzius$', 'Tom Wiltzius').
  replace('Chris Dibona', 'Chris DiBona').
  replace('Colt Mcanlis', 'Colt McAnlis').
  replace('John Mccutchan', 'John McCutchan').
  replace('John Mcgowan', 'John McGowan').
  replace('Kc Austin', 'KC Austin').
  replace('Mcnulty', 'McNulty').
  replace('Pete Beverloo', 'Peter Beverloo').
  replace('Pete Lepage', 'Pete LePage').
  replace('Rich Hyndman', 'Richard Hyndman').
  replace('Richard Felcher', 'Richard Fulcher').
  replace('Richard Hyman', 'Richard Hyndman').
  replace('Tv Raman', 'TV Raman').
  replace(/^Aleksey$/, 'Alexis Moussine-Pouchkine').
  replace(/^Alexis Moussine Pouchkine$/, 'Alexis Moussine-Pouchkine').
  replace(/^Bidelman$/, 'Eric Bidelman').
  replace(/^Bjorn$/, 'Björn Melinder').
  replace(/^Brin$/, 'Sergey Brin').
  replace(/^Colt Mcanis$/, 'Colt McAnlis').
  replace(/^Cromwell$/, 'Ray Cromwell').
  replace(/^Dan$/, 'Dan Galpin').
  replace(/^Divya Mannian$/, 'Divya Manian').
  replace(/^Feldman$/, 'Pavel Feldman').
  replace(/^Fette$/, 'Ian Fette').
  replace(/^Fisher$/, 'Darin Fisher').
  replace(/^Grace$/, 'Grace Kloba').
  replace(/^Glazkov$/, 'Dimitri Glazkov').
  replace(/^Gundotra$/, 'Vic Gundotra').
  replace(/^Ilya$/, 'Ilya Grigorik').
  replace(/^Irish$/, 'Paul Irish').
  replace(/^Jake$/, 'Jake Archibald').
  replace(/^Justin$/, 'Justin Uberti').
  replace(/^Kay$/, 'Erik Kay').
  replace(/^Larry$/, 'Larry Page').
  replace(/^Malanet$/, 'Mallinath Bareddy').
  replace(/^Matthew Gaunt$/, 'Matt Gaunt').
  replace(/^Matt MCneill$/, 'Matt McNeill').
  replace(/^Mc$/, 'MC').
  replace(/^Natasha$/, 'Natasha Rooney').
  replace(/^Nick$/, 'Nick Butcher').
  replace(/^Nurik$/, 'Roman Nurik').
  replace(/^Pamela$/, 'Pamela Fox').
  replace(/^Papakipos$/, 'Matt Papakipos').
  replace(/^Per$/, 'Per Emanuelsson').
  replace(/^Pete Lapage$/, 'Pete LePage').
  replace(/^Rahul$/, 'Rahul Roy-chowdhury').
  replace(/^Raman$/, 'TV Raman').
  replace(/^Ray$/, 'Ray Punyabrata').
  replace(/^Roman$/, 'Roman Nurik').
  replace(/^Roomann-Kurrik$/, 'Arne Roomann-Kurrik').
  replace(/^Sam$/, 'Sam Dutton').
  replace(/^Schmidt$/, 'Eric Schmidt').
  replace(/^Shanee Nistry$/, 'Shanee Nishry').
  replace(/^Shanee$/, 'Shanee Nishry').
  replace(/^Souder$/, 'Steve Souders').
  replace(/^Souders$/, 'Steve Souders').
  replace(/^Sparky$/, 'Sparky Rhode').
  replace(/^Terrence$/, 'Terrence Eden').
  replace(/^Todd$/, 'Todd Kerpelman').
  replace(/^Tom$/, 'Tommy Widenflycht').
  replace(/^Urs Hlzle$/, 'Urs Hölzle').
  replace(/^Urs Hoelzle$/, 'Urs Hölzle').
  replace(/^Urs Holzle$/, 'Urs Hölzle').
  replace(/^Wichary$/, 'Marcin Wichary').
  replace(/^Wilson$/, 'Chris Wilson').
  replace(/^Wolff$/, 'Wolff Dobson').
  replace(/^Yossi$/, 'Yossi Elkrief');
}

var ignoredspeakers = ['Audience', 'Audience member', 'Male Speaker',
  'Female Speaker', 'All', 'Playback', 'Man', 'Announcer', 'Moderator',
  'Producer', 'Fundamentals', 'Female Voice', 'Together', 'Male Voice',
  'Male Speakers', 'Cameraman', 'Unknown Speaker', 'Moderator', 'Remember',
  'The', 'Describer', 'Caller'
];

function isSpeakerAllowed(speaker) {
  return ignoredspeakers.indexOf(speaker) === -1;
}

// from stackoverflow.com/questions/17200640/javascript-capitalize-first-letter-of-each-word-in-a-string-only-if-lengh-2?rq=1
function capitalize(string) {
  return string.toLowerCase().replace(/\b[a-z](?=[a-z]+)/g, function(letter) {
    return letter.toUpperCase();
  }); // hack :(
}

function tweakText(text) {
  return text.replace(/ - /gm, ' &mdash; ').
  replace(urlRegex, '<a href="$1">$1</a>').
  replace(/ (g.co[\/a-z\d-+]+)/gm, ' <a href="https://$1">$1</a>').
  replace(/>https?:\/\//gm, '>').
  replace(/\/</gm, '<').
  replace(/\n- /gm, '<br>• ').
  replace(/\\n- /gm, '<br>• ').
  replace(/(\r)?\n/gm, '<br>').
  replace(/(\\r)?\\n/gm, '<br>').
  replace(/&gt;&gt; ?/gm, '').
  replace(/&amp;gt;&amp;gt; ?/gm, '').
  replace(/&amp;gt; ?/gm, '').
  replace(/^>+/gm, '').
  replace(/&#39;/gm, '\'').
  replace(/&amp;#39;/gm, '\'').
  replace(/&quot;/gm, '\'').
  replace(/--/gm, ' &mdash; ').
  replace(/ - /gm, ' &mdash; ').
  replace(/\s{2,}/gm, ' ');
}

function elapsed() {
  return process.hrtime(timer)[0];
}
