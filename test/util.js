/*
 * (C) Copyright 2017 o2r project
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

const request = require('request');
const archiver = require('archiver');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const tags = require('mocha-tags');
const debug = require('debug')('test:util');
const path = require('path');
const hasher = require('node-object-hash');
var hashSortCoerce = hasher();
const AsyncPolling = require('async-polling');

debug('Test filter: ', tags.filter);

require("./setup");
debug('Using loader at ' + global.test_host_loader);

const cookie_plain = 's:yleQfdYnkh-sbj9Ez--_TWHVhXeXNEgq.qRmINNdkRuJ+iHGg5woRa9ydziuJ+DzFG9GnAZRvaaM';

// TODO rewrite function to start the request here instead of just creating the request object,
// so that we can pipe the archive, see https://github.com/archiverjs/node-archiver/issues/165#issuecomment-166710026
module.exports.createCompendiumPostRequest = function (dataPath, cookie, type = 'compendium', done) {
  zipHash = hashSortCoerce.hash({ path: dataPath, type: type });
  tmpfile = path.join(os.tmpdir(), 'o2r-muncher-upload_' + zipHash + '.zip');

  let formData = {
    'content_type': type,
    'compendium': {
      value: null,
      options: {
        filename: 'another.zip',
        contentType: 'application/zip'
      }
    }
  };
  let j = request.jar();
  let ck = request.cookie('connect.sid=' + cookie);
  j.setCookie(ck, global.test_host_loader);

  let reqParams = {
    uri: global.test_host_loader + '/api/v1/compendium',
    method: 'POST',
    jar: j,
    formData: formData,
    timeout: 120000
  };

  fs.access(tmpfile, (err) => {
    if (err) {
      output = fs.createWriteStream(tmpfile);
      archive = archiver('zip', {
        zlib: { level: zlib.constants.Z_BEST_SPEED }
      });
      archive.on('end', function () {
        debug('Created zip file %s (%s total bytes)', tmpfile, archive.pointer());
        reqParams.formData.compendium.value = fs.createReadStream(tmpfile);
        debug('Created creation request: %O', reqParams);
        done(reqParams);
      });
      archive.on('warning', function (err) {
        if (err.code === 'ENOENT') {
          debug(err);
        } else {
          throw err;
        }
      });
      archive.on('error', function (err) {
        throw err;
      });
      archive.pipe(output);

      debug('writing files from %s to %s', path, tmpfile);
      archive.directory(dataPath, false);
      archive.finalize();
    } else {
      debug('USING CACHED ZIP file for upload: %s | You MUST MANUALLY DELETE IT if the files at %s changed!)', tmpfile, dataPath);
      reqParams.formData.compendium.value = fs.createReadStream(tmpfile);
      debug('Created creation request: %O', reqParams);
      done(reqParams);
    }
  });
}

// publish a candidate with a direct copy of the metadata
module.exports.publishCandidate = function (compendium_id, cookie, done) {
  let j = request.jar();
  let ck = request.cookie('connect.sid=' + cookie);
  j.setCookie(ck, global.test_host);

  let getMetadata = {
    uri: global.test_host + '/api/v1/compendium/' + compendium_id,
    method: 'GET',
    jar: j,
    timeout: 10000
  };

  let updateMetadata = {
    uri: global.test_host + '/api/v1/compendium/' + compendium_id + '/metadata',
    method: 'PUT',
    jar: j,
    timeout: 10000
  };

  request(getMetadata, (err, res, body) => {
    let response = JSON.parse(body);
    if (err) {
      console.error('error publishing candidate: %s', err);
    } else if (response.error) {
      console.error('error publishing candidate: %s', JSON.stringify(response));
      throw new Error('Could not publish candidate, aborting test.');
    } else {
      updateMetadata.json = { o2r: response.metadata.o2r };

      request(updateMetadata, (err, res, body) => {
        debug("Published candidate: %s", JSON.stringify(body).slice(0, 80));
        done();
      });
    }
  });
}

module.exports.startJob = function (compendium_id, done) {
  let j = request.jar();
  let ck = request.cookie('connect.sid=' + cookie_plain);
  j.setCookie(ck, global.test_host);

  request({
    uri: global.test_host + '/api/v1/job',
    method: 'POST',
    jar: j,
    formData: {
      compendium_id: compendium_id
    },
    timeout: 1000
  }, (err, res, body) => {
    let response = JSON.parse(body);
    debug("Started job: %o", response);
    done(response.job_id);
  });
}

module.exports.waitForJob = function (job_id, done) {
  var polling = AsyncPolling(function (end) {
    request({
      uri: global.test_host + '/api/v1/job/' + job_id,
      method: 'GET',
      timeout: 500
    }, (err, res, body) => {
      if (err) end(err, null);
      else {
        let response = JSON.parse(body);
        if (response.status !== 'running') {
          end(null, response);
        } else {
          end(new Error(response.status));
        }
      }
    });
  }, 3000);

  polling.on('error', function (error) {
    debug("Job %s: %s", job_id, error.message);
  });

  polling.on('result', function (result) {
    debug('Job finished with %s', result.status);
    done(result.status);
    polling.stop();
  });

  polling.run();
}
