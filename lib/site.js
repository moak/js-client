var model = require("./model"),
    Form  = require("./form").Form,
    Submission = require("./submission").Submission,
    File = require("./file").File,
    Snippet = require("./snippet").Snippet;

if (typeof(require) !== 'undefined') {
  var glob   = require("glob"),
      path   = require("path"),
      crypto = require("crypto"),
      fs     = require("fs");
}

var Site = model.constructor();
Site.path = "/sites";

var globFiles = function(dir, cb) {
  glob("**/*", {cwd: dir}, function(err, files) {
    if (err) return cb(err);

    var filtered = files.filter(function(file) {
      return file.match(/(\/__MACOSX|\/\.)/) ? false : true;
    }).map(function(file) { return {rel: file, abs: path.resolve(dir, file)}; });

    filterFiles(filtered, cb);
  });
};

var filterFiles = function(filesAndDirs, cb) {
  var processed = [],
      files     = [],
      cbCalled  = false;
  filesAndDirs.forEach(function(fileOrDir) {
    fs.lstat(fileOrDir.abs, function(err, stat) {
      if (cbCalled) return null;
      if (err) { cbCalled = true; return cb(err); }
      if (stat.isFile()) {
        files.push(fileOrDir);
      }
      processed.push(fileOrDir);
      if (processed.length == filesAndDirs.length) {
        cb(null, files);
      }
    });
  });
};

var calculateShas = function(files, cb) {
  var shas = {},
      cbCalled = false,
      processed = [];

  files.forEach(function(file) {
    fs.readFile(file.abs, function(err, data) {
      if (cbCalled) return null;
      if (err) { cbCalled = true; return cb(err); }

      var shasum = crypto.createHash('sha1');
      shasum.update(data);
      shas[file.rel] = shasum.digest('hex');
      processed.push(file);
      if (processed.length == files.length) {
        cb(null, shas);
      }
    });
  });
};

var createFromDir = function(client, dir, siteId, cb) {
  var fullDir = dir.match(/^\//) ? dir : process.cwd() + "/" + dir;

  globFiles(fullDir, function(err, files) {
    calculateShas(files, function(err, filesWithShas) {
      client.request({
        url: "/sites" + (siteId ? "/" + siteId : ""),
        type: siteId ? "put" : "post",
        body: JSON.stringify({
          files: filesWithShas
        })
      }, function(err, data) {
        if (err) return cb(err);
        var site = new Site(client, data);
        var shas = {};
        data.required.forEach(function(sha) { shas[sha] = true; });
        var filtered = files.filter(function(file) { return shas[filesWithShas[file.rel]]; });
        site.uploadFiles(filtered, function(err, site) {
          cb(err, site);
        });
      });
    });
  });
};

var createFromZip = function(client, zip, siteId, cb) {
  var fullPath = zip.match(/^\//) ? zip : process.cwd() + "/" + zip;
  
  fs.readFile(fullPath, function(err, zipData) {
    if (err) return cb(err);
    
    client.request({
      url: "/sites" + (siteId ? "/" + siteId : ""),
      type: siteId ? "put" : "post",
      body: zipData,
      contentType: "application/zip"
    }, function(err, data) {
      if (err) return cb(err);
      
      return cb(null, new Site(client, data));
    });
  });
};

var attributesForUpdate = function(attributes) {
  var mapping = {
        name: "name",
        customDomain: "custom_domain",
        notificationEmail: "notification_email",
        password: "password"
      },
      result = {};
  
  for (var key in attributes) {
    if (mapping[key]) result[mapping[key]] = attributes[key];
  }
  
  return result;
};

Site.createFromDir = function(client, dir, cb) {
  createFromDir(client, dir, null, cb);
};

Site.createFromZip = function(client, zip, cb) {
  createFromZip(client, zip, null, cb);
};

Site.prototype = {
  isReady: function() {
    return this.state == "current";
  },
  refresh: function(cb) {
    var self = this;
    this.client.request({
      url: "/sites/" + this.id
    }, function(err, data, client) {
      if (err) return cb(err);
      Site.call(self, client, data);
      cb(null, self);
    });
  },

  update: function(attributes, cb) {
    attributes = attributes || {};

    var self = this;
    
    if (attributes.dir) {
      createFromDir(this.client, attributes.dir, this.id, cb);
    } else if (attributes.zip) {
      createFromZip(this.client, attributes.zip, this.id, cb);
    } else {
      this.client.request({
        url: "/sites/" + this.id,
        type: "put",
        body: attributesForUpdate(attributes)
      }, function(err, data, client) {
        if (err) return cb(err);
        Site.call(self, client, data);
        cb(null, self);
      });
    }
  },
  
  destroy: function(cb) {
    var self = this;

    this.client.request({
      url: "/sites/" + this.id,
      type: "delete",
      ignoreResponse: true
    }, function(err) {
      cb(err, self);
    });
  },
  
  waitForReady: function(cb) {
    var self = this;

    if (this.isReady()) {
      process.nextTick(function() { cb(null, self); });
    } else {
      setTimeout(function() { self.waitForReady(cb); }, 1000);
    }
  },
  
  forms: function(cb) {
    this.client.collection(this.apiPath, Form, cb);
  },
  
  submissions: function(cb) {
    this.client.collection(this.apiPath, Submission, cb);
  },
  
  files: function(cb) {
    this.client.collection(this.apiPath, File, cb);
  },
  
  file: function(path, cb) {
    this.client.element(this.apiPath, File, path, cb);
  },
  
  snippets: function(cb) {
    this.client.collection(this.apiPath, Snippet, cb);
  },
  
  snippet: function(id, cb) {
    this.client.element(this.apiPath, Snippet, cb);
  },

  uploadFiles: function(files, cb) {
    if (this.state !== "uploading") return cb(null, this);
    if (files.length == 0) { return this.refresh(cb); }

    var self = this,
        cbCalled = false,
        uploaded = [];
    
    files.forEach(function(file) {
      fs.readFile(file.abs, function(err, data) {
        if (cbCalled) return null;
        if (err) { cbCalled = true; return cb(err); }

        self.client.request({
          url: "/sites/" + self.id + "/files/" + file.rel,
          type: "put",
          body: data,
          contentType: "application/octet-stream",
          ignoreResponse: true
        }, function(err) {
          if (cbCalled) return null;
          if (err) { cbCalled = true; return cb(err); }
          uploaded.push(file);
        
          if (uploaded.length == files.length) {
            self.refresh(cb);
          }
        });
      });
    });
  }
};

exports.Site = Site;