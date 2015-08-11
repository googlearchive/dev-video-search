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

var httpModule = require('http');
var requestModule = require('request');
var urlModule = require('url');

var account = 'samdutton';
var password = process.env.cloudant;

var dbUrl = 'https://' + account + ':' + password + '@' + account +
  '.cloudant.com/shearch/_design/videos/';

var SEARCHLIMIT = 10;
// var CUSTOMLIMIT = 50;

// to handle requests for video data or transcript, given an ID
// e.g. shearch.me/p2HzZkd2A40 or shearch.me/t/2UKPRbrw3Kk,p2HzZkd2A40
// view URLs
var allFieldsViewUrl = dbUrl + '_view/all?include_docs=true&keys=';
var transcriptViewUrl = dbUrl + '_view/transcript?keys=';
// index search URL
var allFieldsSearchUrl = dbUrl + '_search/allFields?limit=' + SEARCHLIMIT +
  '&q=';
// counts should not return and documents, so limit=0
var countUrl = dbUrl + '_search/allFields?limit=0&q=';

var queryObject;
var request;
var response;

// TODO: something more robust
process.on('uncaughtException', function(error) {
  console.log('Caught unhandled exception: ' + error);
  //  main();
});

function main() {
  console.log('Starting server');
  httpModule.createServer(function(req, res) {
    request = req;
    response = res;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    queryObject = urlModule.parse(request.url, true).query;
    handleRequest();
  }).listen(8080);
}

main();

function handleRequest() {
  var url = request.url;
  console.log('\n>>>> Request from client: ' + url);

  // to handle requests for video data or transcript, given an ID
  // e.g. shearch.me/p2HzZkd2A40 or shearch.me/t/2UKPRbrw3Kk,p2HzZkd2A40
  var allViewMatches =
    url.match(/^\/([^=?\/]+)$/);
  var transcriptViewMatches =
    url.match(/^\/(?:t|transcript|captions)?\/([^?]+)$/);

  if (url === '/favicon.ico' || url === '/') {
    return; // :^\
    // TODO: better regex – allView matches /t/<ID> URLs too
  } else if (transcriptViewMatches) {
    // for database views, query is a stringified array of video IDs
    doDatabaseRequest(transcriptViewMatches[1].split(/[,;|]( |%20)?/),
      transcriptViewUrl);
  } else if (allViewMatches) {
    doDatabaseRequest(allViewMatches[1].split(/[,;|]( |%20)?/),
      allFieldsViewUrl);
  } else {
    // for database searches, query is a string
    var query = tweakText(url);

    var countProp; // count or countall
    for (var prop in queryObject) {
      if (/count/.test(prop)) {
        countProp = prop;
      }
    }
    if (countProp) {
      // database counts have to be done with string fields
      // these have names like viewCountString and durationSecondsString
      queryObject[countProp] = queryObject[countProp].
      replace(/comments?/, 'commentCountString').
      replace(/dislikes?/, 'dislikeCountString').
      replace(/duration/, 'durationSecondsString').
      replace(/favou?rites?/, 'favoriteCountString').
      replace(/likes?/, 'likeCountString').
      replace(/views?/, 'viewCountString');

      // if there is a query as well as a count parameter
      if (Object.keys(queryObject).length > 1) {
        query += '&counts=["' + queryObject[countProp] + '"]';
      } else { // count only, *:* matches all documents
        query = '*:*&counts=["' + queryObject[countProp] + '"]';
      }
      doDatabaseRequest(query, countUrl);
      return;
    }

    var bookmark = queryObject.bookmark;
    if (bookmark) {
      doDatabaseRequest(query + '&bookmark=' + bookmark);
    } else {
      doDatabaseRequest(query);
    }

    console.log('>>>>> query: ' + query);
  }

}

function tweakText(query) {
  query = dateReplace(query);

  // bookmark parameter is added separately to avoid quotes being added
  // as they are for other paramaters
  query = query.replace(/&?count(all)?=\w+/, ''). // added from queryObject
  replace(/&?bookmark=[\w-]+/, ''). // added from queryObject
  replace(/&?sort=[%\w-]+/, ''). // added in doDatabaseRequest(), < > escaped
  // check for ?q=foo queries (which should match any field)
  replace(/\bq=([^&\|]+)/,
    '(transcript=$1|description=$1|speakers=$1|title=$1|id=$1)').
  // attempts to fix spaces and quotes in requests
  replace(/(\w+) ?%3C ?(\d+)/g, '$1:[0 TO $2]').
  replace(/(\w+) ?%3E ?(\d+)/g, '$1:[$2 TO Infinity]').
  // remove cruft from start
  replace('/?', '').
  // shortcuts
  replace(/\b(c=)/, 'transcript=').
  replace(/\b(captions=)/, 'transcript=').
  replace(/\b(d=)/, 'description=').
  replace(/\b(s=)/, 'speakers=').
  replace(/\b(speaker=)/, 'speakers='). // easy mistake
  replace(/\b(t=)/, 'title=').
  // quote all query values to allow spaces in queries
  replace(/=([^&)|]+)/gm, '="$1"').
  // replace(/&?from=[^&%]+/g, '').
  // replace(/&?to=[^&%]+/g, '').
  // Cloudant uses OR, AND (and : instead of =)
  replace(/\|{1,2}/g, '+OR+').
  replace(/&/g, '+AND+').
  replace(/=/g, ':');

  // fuzzy matching doesn't work with quotes
  if (query.indexOf('~') !== -1) {
    query = query.replace(/%22|"/g, '');
  }

  return query;
}

function dateReplace(query) {
  var from = queryObject.from;
  if (from && /^[a-zA-Z]+$/.test(from)) {
    from += ' ' + new Date().getFullYear();
  }
  var to = queryObject.to;
  if (to && /^[a-zA-Z]+$/.test(to)) {
    to += ' ' + new Date().getFullYear();
  }

  var unixFrom = Date.parse(from);
  var unixTo = Date.parse(to);

  if (from && !to) {
    query = query.replace(/(&?)(from=[^&%\)\|]+)/, '$1publishedAtUnix:[' +
      unixFrom + ' TO Infinity]');
  }

  if (to && !from) {
    query = query.replace(/(&?)(to=[^&%\)\|]+)/, '$1publishedAtUnix:[0 TO ' +
      unixTo +
      ']');
  }

  if (from && to) {
    query = query.replace(/(&?)from=[^&%\)\|]+/, '$1publishedAtUnix:[' +
      unixFrom +
      ' TO ' + unixTo + ']').
    replace(/&to=[^&%\)\|]+/, '');
  }
  return query;
}

function doDatabaseRequest(query, customUrl) {
  var requestUrl;
  if (customUrl) {
    // for database views, query must be an array – so need to stringify
    if (customUrl === allFieldsViewUrl || customUrl === transcriptViewUrl) {
      query = JSON.stringify(query);
    }
    requestUrl = customUrl + query;
  } else {
    requestUrl = allFieldsSearchUrl + query;
    if (queryObject.sort) {
      requestUrl += '&sort="' + queryObject.sort + '"';
    }
  }

  console.log('>>>> Request to database: ', requestUrl);

  requestModule({
    uri: requestUrl
  }, function(error, response, body) {
    if (!error && response.statusCode === 200) {
      respondToClient(body, customUrl);
    } else {
      console.log('Request error: ', error, body);
      respondToClient('', customUrl); // empty response for error
    }
  });
}

function respondToClient(body, customUrl) {
  var i;
  var row;
  var prop;
  var bodyObject = JSON.parse(body);

  // customUrl means a request for a database view, not search
  // e.g. shearch.me/p2HzZkd2A40 or shearch.me/t/2UKPRbrw3Kk,p2HzZkd2A40
  if (customUrl) {

    var countsObject;
    if (queryObject.count) {
      countsObject = bodyObject.counts[queryObject.count];
      var sum = 0;
      for (var count in countsObject) {
        // counts is an object whose keys are amounts and
        // values are number of occurences
        sum += count * countsObject[count];
      }
      response.end(JSON.stringify(sum));
      return;
    } else if (queryObject.countall) {
      countsObject = bodyObject.counts[queryObject.countall];
      response.end(JSON.stringify(countsObject));
      return;
    }

    var results = [];
    for (i = 0; i !== bodyObject.rows.length; ++i) {
      var result = {};
      row = bodyObject.rows[i];
      result.id = row.key;
      if (customUrl === transcriptViewUrl) {
        result.transcript = row.value;
      } else if (customUrl === allFieldsViewUrl) {
        for (prop in row.doc) {
          if (prop !== '_id' && prop !== '_rev') {
            result[prop] = row.doc[prop];
          }
        }
      }
      results.push(result);
    }
    response.end(JSON.stringify(results));
    return;
  }

  // searchTerm is the term searched for in captions or text fields
  // e.g. with captions=webrtc, c=webrtc or q=webrtc requests
  var searchTerm = queryObject.transcript ||
    queryObject.captions || queryObject.c ||
    queryObject.q || queryObject.title ||
    queryObject.t || queryObject.description ||
    queryObject.d || queryObject.speaker ||
    queryObject.s;
  console.log('>>>> searchTerm: ' + searchTerm);

  // add <em> for search term
  // messes up links – removed for the moment
  //  body = body.replace(new RegExp('(' + searchTerm + ')', 'gi'), '<em>$1</em>');

  var videos = [];
  for (i = 0; i !== bodyObject.rows.length; ++i) {
    row = bodyObject.rows[i];
    // remove captions that don't include searchTerm
    if (row.fields.captions) {
      var pruned = pruneCaptions(row.fields.captions, searchTerm);
      if (pruned.length > 0) {
        row.fields.captions = pruned;
      } else {
        delete row.fields.captions;
      }
    }
    // Cloudant search returns single items as a string, not a single-item array :(
    if (row.fields.speakers && typeof row.fields.speakers === 'string') {
      row.fields.speakers = [row.fields.speakers];
    }
    var video = {};
    for (prop in row.fields) {
      video[prop] = row.fields[prop];
    }
    videos.push(video);
  }

  var params = {
    totalResults: bodyObject['total_rows'], // jshint ignore:line
    resultsPerPage: SEARCHLIMIT,
    bookmark: bodyObject.bookmark,
    videos: videos
  };

  // response.writeHead(200, {
  //   'Content-Type': 'text/plain',
  //   'Access-Control-Allow-Origin': '*'
  // });
  response.end(JSON.stringify(params));
}

function pruneCaptions(captions, searchTerm) {
  var re = new RegExp(searchTerm, 'i');
  return captions.filter(function(value) {
    return re.test(value);
  });
}
