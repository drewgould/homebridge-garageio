var fetch = require("node-fetch");
var FormData = require('form-data');

var Accessory, Service, Characteristic, UUIDGen;

module.exports = function (homebridge) {
    Accessory = homebridge.platformAccessory;
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    UUIDGen = homebridge.hap.uuid;

    homebridge.registerPlatform("homebridge-garageio", "GarageIO", GarageIOInterface, true);
}

// This seems to be the "id" of the official LiftMaster iOS app
//var APP_ID = "eU97d99kMG4t3STJZO/Mu2wt69yTQwM0WXZA5oZ74/ascQ2xQrLD/yjeVhEQccBZ";

// Headers needed for validation
// var HEADERS = {
//     "Content-Type": "application/json",
//     "User-Agent": "Garageio/3.1.7 (com.garageio.ios; build:503; iOS 10.3.0) Alamofire/3.5.0",
//     "BrandID": "2",
//     "ApiVersion": "4.1",
//     "Culture": "en",
//     "MyQApplicationID": APP_ID
// };
var HEADERS = {
    "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
    "User-Agent": "Garageio/3.1.7 (com.garageio.ios; build:503; iOS 10.3.0) Alamofire/3.5.0",
};


function GarageIOInterface(log, config, api) {
    this.log = log;
    this.config = config || { "platform": "GarageIO" };
    this.username = this.config.username;
    this.password = this.config.password;
    this.openDuration = parseInt(this.config.openDuration, 10) || 15;
    this.closeDuration = parseInt(this.config.closeDuration, 10) || 15;
    this.polling = this.config.polling === true;
    this.longPoll = parseInt(this.config.longPoll, 10) || 30;
    this.shortPoll = parseInt(this.config.shortPoll, 10) || 5;
    this.shortPollDuration = parseInt(this.config.shortPollDuration, 10) || 120;
    this.maxCount = this.shortPollDuration / this.shortPoll;
    this.count = this.maxCount;
    this.validData = false;

    this.accessories = {};

    if (api) {
        this.api = api;
        this.api.on('didFinishLaunching', this.didFinishLaunching.bind(this));
    }

    // Definition Mapping
    this.doorState = ["open.", "closed.", "opening.", "closing.", "stopped."];
}

// Method to restore accessories from cache
GarageIOInterface.prototype.configureAccessory = function (accessory) {
    this.setService(accessory);
    this.accessories[accessory.context.deviceID] = accessory;
}

// Method to setup accesories from config.json
GarageIOInterface.prototype.didFinishLaunching = function () {
    if (this.username && this.password) {
        // Add or update accessory in HomeKit
        this.addAccessory();

        // Start polling
        if (this.polling) this.statePolling(0);
    } else {
        this.log("Please setup Garageio login information!");
        for (var deviceID in this.accessories) {
            var accessory = this.accessories[deviceID];
            this.removeAccessory(accessory);
        }
    }
}

// Method to add or update HomeKit accessories
GarageIOInterface.prototype.addAccessory = function () {
    var self = this;

    this.login(function (error) {
        if (!error) {
            for (var deviceID in self.accessories) {
                var accessory = self.accessories[deviceID];
                if (!accessory.reachable) {
                    // Remove extra accessories in cache
                    self.removeAccessory(accessory);
                } else {
                    // Update inital state
                    self.updateDoorStates(accessory);
                    self.log("Initializing platform accessory '" + accessory.context.name + " (ID: " + deviceID + ")'...");
                }
            }
        }
    });
}

// Method to remove accessories from HomeKit
GarageIOInterface.prototype.removeAccessory = function (accessory) {
    if (accessory) {
        var deviceID = accessory.context.deviceID;
        this.log(accessory.context.name + " is removed from HomeBridge.");
        this.api.unregisterPlatformAccessories("homebridge-garageio", "GarageIO", [accessory]);
        delete this.accessories[deviceID];
    }
}

// Method to setup listeners for different events
GarageIOInterface.prototype.setService = function (accessory) {
    accessory.getService(Service.GarageDoorOpener)
        .getCharacteristic(Characteristic.CurrentDoorState)
        .on('get', this.getCurrentState.bind(this, accessory.context));

    accessory.getService(Service.GarageDoorOpener)
        .getCharacteristic(Characteristic.TargetDoorState)
        .on('get', this.getTargetState.bind(this, accessory.context))
        .on('set', this.setTargetState.bind(this, accessory.context));

    accessory.on('identify', this.identify.bind(this, accessory));
}

// Method to setup HomeKit accessory information
GarageIOInterface.prototype.setAccessoryInfo = function (accessory, model, serial) {
    accessory.getService(Service.AccessoryInformation)
        .setCharacteristic(Characteristic.Manufacturer, this.manufacturer)
        .setCharacteristic(Characteristic.Model, model)
        .setCharacteristic(Characteristic.SerialNumber, serial);
}

// Method to update door state in HomeKit
GarageIOInterface.prototype.updateDoorStates = function (accessory) {
    console.log('updateDoorStates for', accessory);
    accessory.getService(Service.GarageDoorOpener)
        .setCharacteristic(Characteristic.CurrentDoorState, accessory.context.currentState);

    accessory.getService(Service.GarageDoorOpener)
        .getCharacteristic(Characteristic.TargetDoorState)
        .getValue();
}

// Method to retrieve door state from the server
GarageIOInterface.prototype.updateState = function (callback) {
    if (this.validData && this.polling) {
        // Refresh data directly from sever if current data is valid
        this.getDevice(callback);
    } else {
        // Re-login if current data is not valid
        this.login(callback);
    }
}

// Method for state periodic update
GarageIOInterface.prototype.statePolling = function (delay) {
    var self = this;
    var refresh = this.longPoll + delay;

    // Clear polling
    clearTimeout(this.tout);

    // Determine polling interval
    if (this.count < this.maxCount) {
        this.count++;
        refresh = this.shortPoll + delay;
    }

    // Setup periodic update with polling interval
    this.tout = setTimeout(function () {
        self.updateCurrentStates();
        self.updateState(function (error) {
            if (!error) {
                // Update states for all HomeKit accessories
                for (var deviceID in self.accessories) {
                    var accessory = self.accessories[deviceID];
                    self.updateDoorStates(accessory);
                }
            } else {
                // Re-login after short polling interval if error occurs
                self.count = self.maxCount - 1;
            }

            // Setup next polling
            self.statePolling(0);
        });
    }, refresh * 1000);
}

// Login to MyQ server
GarageIOInterface.prototype.login = function (callback) {
    var self = this;

    // Body stream for validation
    var body = "email_address=" + encodeURI(self.username) + "&password=" + encodeURI(self.password);

    // login to garageio
    fetch("https://garageio.com/api/controllers/v1/Auth/", {
        method: "POST",
        headers: HEADERS,
        body: body
    }).then(function (res) {
        return res.json();
        //return res.json();
    }).then(function (data) {
        console.log(data);
        // Check for success from call
        if (data.success == true) {
            self.securityToken = data.data[0].authentication_token;
            self.securityTokenExp = data.data.expires;
            self.userID = data.userid;
            self.manufacturer = "Garageio";
            self.getDevice(callback);
        } else {
            self.log(data.message);
            callback(data.message);
        }
    });
}

// Find your garage door ID(s)
GarageIOInterface.prototype.getDevice = function (callback) {
    var self = this;
    // Reset validData hint until we retrived data from the server
    this.validData = false;

    // Querystring params
    var query = "auth_token=" + encodeURI(self.securityToken) + "&user_id=" + encodeURI(self.userID);
    console.log('query', query);
    // Adding security token to headers
    var getHeaders = JSON.parse(JSON.stringify(HEADERS));
    getHeaders.SecurityToken = this.securityToken;

    // Request details of all your devices
    fetch("https://garageio.com/api/controllers/v1/Sync?" + query, {
        method: "GET",
        headers: getHeaders,
        query: query
    }).then(function (res) {
        console.log('res', res);
        return res.json();
    }).then(function (data) {
        console.log('query devices returns', data.data.devices);
        if (data.success == true) {
            var devices = data.data.devices;
            console.log(data.doors)
            // Look through the array of devices for all the doors
            for (var i = 0; i < devices.length; i++) {
                var doors = devices[i].doors;

                // loop through the array of doors to store their info
                for (var i = 0; i < doors.length; i++) {
                    var door = doors[i];
                    var thisDeviceID = door.id;
                    var thisSerial = "123" + i;
                    var thisModel = "something";
                    var thisDoorName = door.name;
                    var thisDoorState = door.state;
                    var thisDoorMonitor = door.active;

                    if (thisDoorMonitor == true) {
                        // Retrieve accessory from cache
                        var accessory = self.accessories[thisDeviceID];
                        console.log('accessory', accessory);
                        // Initialization for new accessory
                        if (!accessory) {
                            // Setup accessory as GARAGE_DOOR_OPENER (4) category.
                            var uuid = UUIDGen.generate(thisDeviceID);
                            accessory = new Accessory("Garageio " + thisDoorName, uuid, 4);

                            // Setup HomeKit security system service
                            accessory.addService(Service.GarageDoorOpener, thisDoorName);

                            // New accessory is always reachable
                            accessory.reachable = true;

                            // Setup HomeKit accessory information
                            self.setAccessoryInfo(accessory, thisModel, thisSerial);

                            // Setup listeners for different security system events
                            self.setService(accessory);

                            // Register new accessory in HomeKit
                            self.api.registerPlatformAccessories("homebridge-garageio", "GarageIO", [accessory]);

                            // Store accessory in cache
                            self.accessories[thisDeviceID] = accessory;
                        }
                        // Accessory is reachable after it's found in the server
                        accessory.updateReachability(true);

                        // Store and initialize variables into context
                        var cache = accessory.context;
                        cache.name = thisDoorName;
                        cache.deviceID = thisDeviceID;
                        if (cache.currentState === undefined) cache.currentState = Characteristic.CurrentDoorState.CLOSED;

                        // Determine the current door state
                        console.log("determinetd door state is", thisDoorState);
                        var newState;
                        if (thisDoorState == "CLOSED") {
                            newState = Characteristic.CurrentDoorState.CLOSED;
                        }
                        else {
                            newState = Characteristic.CurrentDoorState.OPEN;
                        }

                        // Detect for state changes
                        if (newState !== cache.currentState) {
                            self.count = 0;
                            cache.currentState = newState;
                        }

                        // Set validData hint after we found an opener
                        self.validData = true;
                    }
                    else {
                        console.log('else');
                    }
                }
            }
            // Did we have valid data?
            if (self.validData) {
                console.log('validdata');
                // Set short polling interval when state changes
                if (self.polling) self.statePolling(0);
                callback();
            } else {
                var parseErr = "Error: Couldn't find a Garageio door device."
                self.log(parseErr);
                callback(parseErr);
            }
        } else {
            self.log("Error getting garageio devices: " + data.ErrorMessage);
            callback(data.ErrorMessage);
        }
    });
}

// Send opener target state to the server
GarageIOInterface.prototype.setState = function (thisOpener, state, callback) {
    var self = this;
    var thisAccessory = this.accessories[thisOpener.deviceID];
    var doorState = state === 1 ? "0" : "1";
    var updateDelay = state === 1 ? this.closeDuration : this.openDuration;
    console.log('state ', state);
    console.log('updateDelay ', updateDelay);

    if (doorState == 0) {
        var doorStateGarageIO = "CLOSED";
    }
    else {
        var doorStateGarageIO = "OPEN";
    }
    console.log('doorStateGarageIO', doorStateGarageIO);
    // Adding security token to headers
    var putHeaders = JSON.parse(JSON.stringify(HEADERS));
    putHeaders.SecurityToken = this.securityToken;

    // Querystring params
    var query = "auth_token=" + encodeURI(self.securityToken) + "&user_id=" + encodeURI(self.userID) + "&door_id=" + encodeURI(thisOpener.deviceID) + "&door_state=" + encodeURI(doorStateGarageIO);
    console.log('open query', query);
    // Send the state request to garageio
    fetch("https://garageio.com/api/controllers/v1/Toggle?" + query, {
        method: "POST",
        headers: putHeaders,
        body: query
    }).then(function (res) {
        //console.log('open res',res);
        return res.json();
    }).then(function (data) {
        console.log('set state response', data);
        if (data.status == "200" || data.success == true) {
            self.log(thisOpener.name + " is set to " + self.doorState[state]);

            if (self.polling) {
                // Set short polling interval
                self.count = 0;
                self.statePolling(updateDelay - self.shortPoll);
            } else {
                // Update door state after updateDelay
                setTimeout(function () {
                    self.updateState(function (error) {
                        if (!error) self.updateDoorStates(thisAccessory);
                    });
                }, updateDelay * 1000);
            }
            callback();
        } else {
            self.log("Error setting " + thisOpener.name + " state: " + state + " " + JSON.stringify(data));
            if (data.message == "Sorry, your Garageio Blackbox didn't respond. Wait a few seconds and try again.") {
                //if you send two open commands for two doors rapid fire the API chokes, so wait a couple seconds and try it again
                setTimeout(function () {
                    self.log('ok lets try the state command again');
                    self.setTargetState(thisOpener, state, function (error) {
                        if (!error) self.updateDoorStates(thisAccessory);
                        self.updateCurrentStates();
                    });
                }, 2000);
            }
            else {
                self.updateCurrentStates();
                callback(data.ErrorMessage);
            }
        }
    }).catch(function (error) {
        console.log(error);
    });
}

// Method to set target door state
GarageIOInterface.prototype.setTargetState = function (thisOpener, state, callback) {
    var self = this;

    // Always re-login for setting the state
    this.login(function (loginError) {
        if (!loginError) {
            self.setState(thisOpener, state, callback);
        } else {
            callback(loginError);
        }
    });
}

// Method to get target door state
GarageIOInterface.prototype.getTargetState = function (thisOpener, callback) {
    // Get target state directly from cache
    callback(null, thisOpener.currentState % 2);
}

// Method to get current door state
GarageIOInterface.prototype.getCurrentState = function (thisOpener, callback) {
    var self = this;

    // Retrieve latest state from server
    this.updateState(function (error) {
        if (!error) {
            self.log(thisOpener.name + " is " + self.doorState[thisOpener.currentState]);
            callback(null, thisOpener.currentState);
        } else {
            callback(error);
        }
    });
}

// Method to update current door states from GarageIO
GarageIOInterface.prototype.updateCurrentStates = function (callback) {
    var self = this;
    // Adding security token to headers
    var getHeaders = JSON.parse(JSON.stringify(HEADERS));
    getHeaders.SecurityToken = this.securityToken;

    // Querystring params
    var query = "auth_token=" + encodeURI(self.securityToken) + "&user_id=" + encodeURI(self.userID);

    // Retrieve latest state from server
    fetch("https://garageio.com/api/controllers/v1/Sync?" + query, {
        method: "GET",
        headers: getHeaders,
        query: query
    }).then(function (res) {
        console.log('res', res);
        return res.json();
    }).then(function (data) {
        console.log('query devices returns', data.data.devices);
        if (data.success == true) {
            var devices = data.data.devices;
            console.log(data.doors)
            // Look through the array of devices for all the doors
            for (var i = 0; i < devices.length; i++) {
                var doors = devices[i].doors;

                // loop through the array of doors to store their info
                for (var i = 0; i < doors.length; i++) {
                    var door = doors[i];
                    var thisDeviceID = door.id;
                    var thisDoorState = door.state;
                    var thisDoorMonitor = door.active;

                    if (thisDoorMonitor == true) {
                        // Retrieve accessory from cache
                        var accessory = self.accessories[thisDeviceID];

                        if (cache.currentState === undefined) cache.currentState = Characteristic.CurrentDoorState.CLOSED;

                        // Determine the current door state
                        console.log("redetermined door state is", thisDoorState);
                        var newState;
                        if (thisDoorState == "CLOSED") {
                            newState = Characteristic.CurrentDoorState.CLOSED;
                        }
                        else {
                            newState = Characteristic.CurrentDoorState.OPEN;
                        }

                        // Detect for state changes
                        if (newState !== cache.currentState) {
                            self.count = 0;
                            cache.currentState = newState;
                        }
                        return self.updateDoorStates(accessory);
                        // Set validData hint after we found an opener
                        self.validData = true;
                    }
                }
            }
        }
    })
}

// Method to handle identify request
GarageIOInterface.prototype.identify = function (thisOpener, paired, callback) {
    this.log(thisOpener.name + " identify requested!");
    callback();
}

// Method to handle plugin configuration in HomeKit app
GarageIOInterface.prototype.configurationRequestHandler = function (context, request, callback) {
    if (request && request.type === "Terminate") {
        return;
    }

    // Instruction
    if (!context.step) {
        var instructionResp = {
            "type": "Interface",
            "interface": "instruction",
            "title": "Before You Start...",
            "detail": "Please make sure homebridge is running with elevated privileges.",
            "showNextButton": true
        }

        context.step = 1;
        callback(instructionResp);
    } else {
        switch (context.step) {
            // Operation choices
            case 1:
                var respDict = {
                    "type": "Interface",
                    "interface": "input",
                    "title": "Configuration",
                    "items": [{
                        "id": "username",
                        "title": "Login Username (Required)",
                        "placeholder": this.username ? "Leave blank if unchanged" : "email"
                    }, {
                        "id": "password",
                        "title": "Login Password (Required)",
                        "placeholder": this.password ? "Leave blank if unchanged" : "password",
                        "secure": true
                    }, {
                        "id": "openDuration",
                        "title": "Time to Open Garage Door Completely",
                        "placeholder": this.openDuration.toString(),
                    }, {
                        "id": "closeDuration",
                        "title": "Time to Close Garage Door Completely",
                        "placeholder": this.closeDuration.toString(),
                    }, {
                        "id": "polling",
                        "title": "Enable Polling (true/false)",
                        "placeholder": this.polling.toString(),
                    }, {
                        "id": "longPoll",
                        "title": "Long Polling Interval",
                        "placeholder": this.longPoll.toString(),
                    }, {
                        "id": "shortPoll",
                        "title": "Short Polling Interval",
                        "placeholder": this.shortPoll.toString(),
                    }, {
                        "id": "shortPollDuration",
                        "title": "Short Polling Duration",
                        "placeholder": this.shortPollDuration.toString(),
                    }]
                }

                context.step = 2;
                callback(respDict);
                break;
            case 2:
                var userInputs = request.response.inputs;

                // Setup info for adding or updating accessory
                this.username = userInputs.username || this.username;
                this.password = userInputs.password || this.password;
                this.openDuration = parseInt(userInputs.openDuration, 10) || this.openDuration;
                this.closeDuration = parseInt(userInputs.closeDuration, 10) || this.closeDuration;
                if (userInputs.polling.toUpperCase() === "TRUE") {
                    this.polling = true;
                } else if (userInputs.polling.toUpperCase() === "FALSE") {
                    this.polling = false;
                }
                this.longPoll = parseInt(userInputs.longPoll, 10) || this.longPoll;
                this.shortPoll = parseInt(userInputs.shortPoll, 10) || this.shortPoll;
                this.shortPollDuration = parseInt(userInputs.shortPollDuration, 10) || this.shortPollDuration;

                // Check for required info
                if (this.username && this.password) {
                    // Add or update accessory in HomeKit
                    this.addAccessory();

                    // Reset polling
                    if (this.polling) {
                        this.maxCount = this.shortPollDuration / this.shortPoll;
                        this.count = this.maxCount;
                        this.statePolling(0);
                    }

                    var respDict = {
                        "type": "Interface",
                        "interface": "instruction",
                        "title": "Success",
                        "detail": "The configuration is now updated.",
                        "showNextButton": true
                    };

                    context.step = 3;
                } else {
                    // Error if required info is missing
                    var respDict = {
                        "type": "Interface",
                        "interface": "instruction",
                        "title": "Error",
                        "detail": "Some required information is missing.",
                        "showNextButton": true
                    };

                    context.step = 1;
                }
                callback(respDict);
                break;
            case 3:
                // Update config.json accordingly
                delete context.step;
                var newConfig = this.config;
                newConfig.username = this.username;
                newConfig.password = this.password;
                newConfig.openDuration = this.openDuration;
                newConfig.closeDuration = this.closeDuration;
                newConfig.polling = this.polling;
                newConfig.longPoll = this.longPoll;
                newConfig.shortPoll = this.shortPoll;
                newConfig.shortPollDuration = this.shortPollDuration;
                callback(null, "platform", true, newConfig);
                break;
        }
    }
}