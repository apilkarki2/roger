var _               = require('lodash');
var Docker          = require('dockerode');
var Q               = require('q');
var fs              = require('fs');
var config          = require('./config');
var tar             = require('./tar');
var utils           = require('./utils');
var os              = require('os');
var docker          = {client: {}};

if (fs.existsSync('/tmp/docker.sock')) {
  docker.client = new Docker({socketPath: '/tmp/docker.sock'});
} else {
  docker.client = new Docker({host: require('netroute').getGateway(), port: 2375});
}

/**
 * Builds a docker image.
 *
 * @return promise
 */
docker.buildImage = function(project, tarPath, imageId, buildId, buildLogger, dockerOptions) {
  var deferred = Q.defer();

  docker.client.buildImage(tarPath, _.extend({t: imageId}, dockerOptions), function (err, response){
    if (err) {
      deferred.reject(err);
    } else {
      buildLogger.info('[%s] Build is in progress...', buildId);

      response.on('data', function(out){
        var result = {}

        try {
          result = JSON.parse(out.toString('utf-8'));
        } catch (err) {
          buildLogger.error('[%s] %s', buildId, err)
        }

        if (result.error) {
          buildLogger.error('[%s] %s', buildId, result.error)
          deferred.reject(result.error);
          return;
        }

        if (result.progress) {
          result.status = result.status + ' ' + result.progress;
        }

        buildLogger.info("[%s] %s", buildId, result.stream || result.status);
      });

      response.on('end', function(){
        deferred.resolve();
      });
    }
  });

  return deferred.promise;
};

/**
 * Tags "branch" off the latest imageId.
 *
 * @return promise
 */
docker.tag = function(imageId, buildId, branch, buildLogger) {
  var deferred  = Q.defer();
  var image     = docker.client.getImage(imageId);

  image.tag({repo: imageId, tag: branch}, function(){
    deferred.resolve(image);
  })

  return deferred.promise;
};

/**
 * Retrieves the authconfig needed
 * in order to push this image.
 *
 * This method is mainly here if you
 * have builds that need to be pushed
 * to the dockerhub.
 *
 * @see http://stackoverflow.com/questions/24814714/docker-remote-api-pull-from-docker-hub-private-registry
 */
docker.getAuth = function(buildId, registry, buildLogger) {
  var options = {};

  if (registry === 'dockerhub') {
    buildLogger.info('[%s] Image should be pushed to the DockerHub @ hub.docker.com', buildId);

    options = config.get('auth.dockerhub');

    if (!options || !options.username || !options.email || !options.password) {
      buildLogger.error('It seems that the build "%s" should be pushed to the dockerhub', buildId);
      buildLogger.error('but you forgot to add your credentials in the config file "%s"', argv.config);
      buildLogger.error();
      buildLogger.error('Please specify:');
      buildLogger.error(' - username');
      buildLogger.error(' - email address');
      buildLogger.error(' - password');
      buildLogger.error();
      buildLogger.error('See https://github.com/namshi/roger#configuration');

      throw new Error('Fatality! MUAHAHUAAHUAH!');
    }

    /**
     * Ok, we can do better.
     * But it's 5.39 in the morning.
     */
    options.serveraddress = '127.0.0.1';
  }

  return options;
};

/**
 * Pushes an image to a registry.
 *
 * @return promise
 */
docker.push = function(image, buildId, uuid, branch, registry, buildLogger) {
  var deferred  = Q.defer();

  image.push({tag: branch, force: true}, function(err, data){
    var somethingWentWrong = false;

    if (err) {
      deferred.reject(err);
    } else {
      data.on('error', function(err){
        deferred.reject(err);
      });

      data.on('data', function(out){
        var message = {}

        try {
          message = JSON.parse(out.toString('utf-8'));
        } catch (err) {
          buildLogger.error("[%s] %s", buildId, err)
        }


        if (message.error) {
          deferred.reject(message)
          somethingWentWrong = true;
        }

        buildLogger.info("[%s] %s", buildId, message.status || message.error)
      });

      data.on('end', function(){
        if (!somethingWentWrong) {
          buildLogger.info("[%s] Pushed image of build %s to the registry at http://%s", buildId, uuid, registry)
          deferred.resolve();
        }
      })
    }
  }, docker.getAuth(buildId, registry, buildLogger));

  return deferred.promise;
};

/**
 * Copies stuff from the container to
 * the host machine.
 */
docker.copy = function(container, containerPath, hostPath) {
  return Q.Promise(function(resolve, reject){
    container.copy({Resource: containerPath}, function(err, data){
      if (err) {
        reject(err);
        return;
      }

      return tar.createFromStream(hostPath, data).then(function(){
        resolve();
      });
    })
  });
}

module.exports = docker;
