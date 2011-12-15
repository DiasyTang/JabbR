﻿/// <reference path="Scripts/jquery-1.7.js" />
/// <reference path="Scripts/jQuery.tmpl.js" />
/// <reference path="Scripts/jquery.cookie.js" />
/// <reference path="Chat.ui.js" />

(function ($, connection, window, ui) {
    "use strict";

    var chat = connection.chat,
        messageHistory = [],
        historyLocation = 0,
        originalTitle = document.title,
        unread = 0,
        isUnreadMessageForUser = false,
        focus = true,
        loadingHistory = false,
        typingTimeoutId = null,
        $ui = $(ui);

    function isSelf(user) {
        return chat.name === user.Name;
    }

    function populateRoom(room) {
        var d = $.Deferred();
        // Populate the list of users rooms and messages 
        chat.getRoomInfo(room)
                .done(function (roomInfo) {
                    $.each(roomInfo.Users, function () {
                        var viewModel = {
                            name: this.Name,
                            hash: this.Hash
                        };

                        ui.addUser(viewModel, room);
                        ui.setUserActivity(this);
                    });

                    $.each(roomInfo.Owners, function () {
                        ui.setRoomOwner(this, room);
                    });

                    $.each(roomInfo.RecentMessages, function () {
                        var viewModel = getMessageViewModel(this);

                        ui.addChatMessage(viewModel, room);
                    });
                    // mark room as initialized to differentiate messages
                    // that are added after initial population
                    ui.setInitialized(room);
                    ui.scrollToBottom(room);

                    d.resolveWith(chat);
                })
                .fail(function () {
                    d.rejectWith(chat);
                });

        return d;
    }

    function populateLobbyRooms() {
        // Populate the user list with room names
        chat.getRooms()
            .done(function (rooms) {
                ui.populateLobbyRooms(rooms);
            });
    }

    function scrollIfNecessary(callback, room) {
        var nearEnd = ui.isNearTheEnd(room);

        callback();

        if (nearEnd) {
            ui.scrollToBottom(room);
        }
    }

    function getMessageViewModel(message) {
        var re = new RegExp("\\b@?" + chat.name.replace(/\./, '\\.') + "\\b", "i");
        return {
            name: message.User.Name,
            hash: message.User.Hash,
            message: message.Content,
            id: message.Id,
            date: message.When.fromJsonDate(),
            highlight: re.test(message.Content) ? 'highlight' : ''
        };
    }

    // Save some state in a cookie
    function updateCookie() {
        var legacyCookies = ['userid', 'username', 'userroom', 'userhash', 'currentroom'],
            state = {
                userId: chat.id,
                activeRoom: chat.activeRoom,
                preferences: ui.getState()
            },
            jsonState = window.JSON.stringify(state);

        // Clear the legacy cookies
        $.each(legacyCookies, function () {
            $.cookie(this, null);
        });

        $.cookie('jabbr.state', jsonState, { path: '/', expires: 30 });
    }

    function updateTitle() {
        if (unread === 0) {
            document.title = originalTitle;
        }
        else {
            document.title =
                (isUnreadMessageForUser ? '*' : '')
                + '(' + unread + ') ' + originalTitle;
        }
    }

    function updateUnread(room, isMentioned) {
        if (focus === false) {
            isUnreadMessageForUser = (isUnreadMessageForUser || isMentioned);

            unread = unread + 1;
        } else {
            //we're currently focused so remove
            //the * notification
            isUnreadMessageForUser = false;
        }

        ui.updateUnread(room, isMentioned);

        updateTitle();
    }

    // Room commands

    // When the /join command gets raised this is called
    chat.joinRoom = function (room) {
        var added = ui.addRoom(room.Name);
        ui.setActiveRoom(room.Name);
        if (room.Private) {
            ui.setRoomLocked(room.Name);
        }

        if (added) {
            populateRoom(room.Name).done(function () {
                ui.addMessage('You just entered ' + room.Name, 'notification', room.Name);
            });
        }
    };

    // Called when a returning users join chat
    chat.logOn = function (rooms) {
        var activeRoom = this.activeRoom,
            loadRooms = function () {
                $.each(rooms, function (index, room) {
                    if (chat.activeRoom !== room.Name) {
                        populateRoom(room.Name);
                    }
                });
                populateLobbyRooms();
            };

        $.each(rooms, function (index, room) {
            ui.addRoom(room.Name);
            if (room.Private) {
                ui.setRoomLocked(room.Name);
            }
        });
        ui.setUserName(chat.name);
        ui.addMessage('Welcome back ' + chat.name, 'notification', 'lobby');
        ui.addMessage('You can join any of the rooms on the right', 'notification', 'lobby');
        ui.addMessage('Type /rooms to list all available rooms', 'notification', 'lobby');

        // Process any urls that may contain room names
        ui.run();

        // If the active room didn't change then set the active room (since no navigation happened)
        if (activeRoom === this.activeRoom) {
            ui.setActiveRoom(this.activeRoom || 'Lobby');
        }

        if (this.activeRoom) {
            // Always populate the active room first then load the other rooms so it looks fast :)
            populateRoom(this.activeRoom).done(loadRooms);
        }
        else {
            // There's no active room so we don't care
            loadRooms();
        }
    };

    chat.lockRoom = function (user, room) {
        if (!isSelf(user) && this.activeRoom === room) {
            ui.addMessage(user.Name + ' has locked ' + room + '.', 'notification', this.activeRoom);
        }

        ui.setRoomLocked(room);
    };

    // Called when this user locked a room
    chat.roomLocked = function (room) {
        ui.addMessage(room + ' is now locked.', 'notification', this.activeRoom);
    };

    chat.addOwner = function (user, room) {
        ui.setRoomOwner(user.Name, room);
    };

    chat.removeOwner = function (user, room) {
        ui.clearRoomOwner(user.Name, room);
    };

    chat.updateRoomCount = function (room, count) {
        ui.updateLobbyRoomCount(room, count);
    };

    chat.markInactive = function (users) {
        $.each(users, function () {
            ui.setUserActivity(this);
        });
    };

    chat.updateActivity = function (user) {
        ui.setUserActivity(user);
    };

    chat.addMessageContent = function (id, content, room) {
        var nearTheEndBefore = ui.isNearTheEnd(room);

        scrollIfNecessary(function () {
            ui.addChatMessageContent(id, content, room);
        }, room);

        updateUnread(room, false /* isMentioned: this is outside normal messages and user shouldn't be mentioned */);

        // Adding external content can sometimes take a while to load
        // Since we don't know when it'll become full size in the DOM
        // we're just going to wait a little bit and hope for the best :) (still a HACK tho)
        window.setTimeout(function () {
            var nearTheEndAfter = ui.isNearTheEnd(room);
            if (nearTheEndBefore && nearTheEndAfter) {
                ui.scrollToBottom();
            }
        }, 850);
    };

    chat.addMessage = function (message, room) {

        var viewModel = getMessageViewModel(message);
        scrollIfNecessary(function () {
            ui.addChatMessage(viewModel, room);

        }, room);

        var isMentioned = viewModel.highlight === 'highlight';

        updateUnread(room, isMentioned);
    };

    chat.addUser = function (user, room, isOwner) {
        var viewModel = {
            name: user.Name,
            hash: user.Hash,
            owner: isOwner
        };

        var added = ui.addUser(viewModel, room);

        if (added) {
            if (!isSelf(user)) {
                ui.addMessage(user.Name + ' just entered ' + room, 'notification', room);
            }
        }
    };

    chat.changeUserName = function (oldName, user, room) {
        ui.changeUserName(oldName, user, room);

        if (!isSelf(user)) {
            ui.addMessage(oldName + '\'s nick has changed to ' + user.Name, 'notification', room);
        }
    };

    chat.changeGravatar = function (user, room) {
        ui.changeGravatar(user, room);

        if (!isSelf(user)) {
            ui.addMessage(user.Name + "'s gravatar changed.", 'notification', room);
        }
    };

    // User single client commands

    chat.allowUser = function (room) {
        ui.addMessage('You were granted access to ' + room, 'notification', this.activeRoom);
    };

    chat.userAllowed = function (user, room) {
        ui.addMessage(user + ' now has access to ' + room, 'notification', this.activeRoom);
    };

    chat.unallowUser = function (user) {
        ui.addMessage('You access to ' + room + ' was revoked.', 'notification', this.activeRoom);
    };

    chat.userUnallowed = function (user, room) {
        ui.addMessage('You have revoked ' + user + '"s access to ' + room, 'notification', this.activeRoom);
    };

    // Called when you make someone an owner
    chat.ownerMade = function (user, room) {
        ui.addMessage(user + ' is now an owner of ' + room, 'notification', this.activeRoom);
    };

    chat.ownerRemoved = function (user, room) {
        ui.addMessage(user + ' is no longer an owner of ' + room, 'notification', this.activeRoom);
    };

    // Called when you've been made an owner
    chat.makeOwner = function (room) {
        ui.addMessage('You are now an owner of ' + room, 'notification', this.activeRoom);
    };

    // Called when you've been removed as an owner
    chat.demoteOwner = function (room) {
        ui.addMessage('You are no longer an owner of ' + room, 'notification', this.activeRoom);
    };

    // Called when your gravatar has been changed
    chat.gravatarChanged = function () {
        ui.addMessage('Your gravatar has been set', 'notification', this.activeRoom);
    };

    // Called when the server sends a notification message
    chat.postNotification = function (msg, room) {
        ui.addMessage(msg, 'notification', room);
    };

    // Called when you created a new user
    chat.userCreated = function () {
        ui.setUserName(this.name);
        ui.addMessage('Your nick is ' + this.name, 'notification');

        // Process any urls that may contain room names
        ui.run();

        if (!this.activeRoom) {
            // Set the active room to the lobby so the rooms on the right load
            ui.setActiveRoom('Lobby');
        }

        // Update the cookie
        updateCookie();
    };

    chat.logOut = function (rooms) {
        ui.setActiveRoom('Lobby');

        // Close all rooms
        $.each(rooms, function () {
            ui.removeRoom(this);
        });

        ui.addMessage("You've been logged out.", 'notification', this.activeRoom);

        chat.activeRoom = undefined;
        chat.name = undefined;
        chat.id = undefined;

        updateCookie();

        // Restart the connection
        connection.stop();
        connection.start();
    };

    chat.showUserInfo = function (userInfo) {
        ui.addMessage('User information for ' + userInfo.Name + 
            " (last seen " + jQuery.timeago(new Date(userInfo.LastActivity)) + ")", 'list-header');
        chat.showUsersRoomList(userInfo.Name, userInfo.Rooms);
        chat.showUsersOwnedRoomList(userInfo.Name, userInfo.OwnedRooms);
    };

    chat.setPassword = function () {
        ui.addMessage('Your password has been set', 'notification', this.activeRoom);
    };

    chat.changePassword = function () {
        ui.addMessage('Your password has been changed', 'notification', this.activeRoom);
    };

    chat.userNameChanged = function (user) {
        // Update the client state
        chat.name = user.Name;
        ui.setUserName(chat.name);
        ui.addMessage('Your name is now ' + user.Name, 'notification', this.activeRoom);
    };

    chat.setTyping = function (user, room, isTyping) {
        ui.setUserTyping(user, room, isTyping);
    };

    chat.sendMeMessage = function (name, message, room) {
        ui.addMessage('*' + name + ' ' + message, 'notification', room);
    };

    chat.sendPrivateMessage = function (from, to, message) {
        if (isSelf({ Name: to })) {
            // Force notification for direct messages
            ui.notify(true);
        }

        ui.addMessage('<emp>*' + from + '* &raquo; *' + to + '*</emp> ' + message, 'pm');
    };

    chat.nudge = function (from, to) {
        function shake(n) {
            var move = function (x, y) {
                parent.moveBy(x, y);
            };
            for (var i = n; i > 0; i--) {
                for (var j = 1; j > 0; j--) {
                    move(i, 0);
                    move(0, -i);
                    move(-i, 0);
                    move(0, i);
                    move(i, 0);
                    move(0, -i);
                    move(-i, 0);
                    move(0, i);
                    move(i, 0);
                    move(0, -i);
                    move(-i, 0);
                    move(0, i);
                }
            }
            return this;
        };
        $("body").effect("pulsate", { times: 3 }, 300);
        window.setTimeout(function () {
            shake(20);
        }, 300);

        ui.addMessage('*' + from + ' nudged ' + (to ? 'you' : 'the room'), to ? 'pm' : 'notification');
    };

    chat.leave = function (user, room) {
        if (isSelf(user)) {
            ui.setActiveRoom('Lobby');
            ui.removeRoom(room);
            ui.addMessage('You have left ' + room, 'notification');
        }
        else {
            ui.removeUser(user, room);
            ui.addMessage(user.Name + ' left ' + room, 'notification', room);
        }
    };

    chat.kick = function (room) {
        ui.setActiveRoom('Lobby');
        ui.removeRoom(room);
        ui.addMessage('You were kicked from ' + room, 'notification');
    };

    // Helpish commands
    chat.showRooms = function (rooms) {
        ui.addMessage('Rooms', 'list-header');
        if (!rooms.length) {
            ui.addMessage('No rooms available', 'list-item');
        }
        else {
            // sort rooms by count descending
            var sorted = rooms.sort(function (a, b) {
                return a.Count > b.Count ? -1 : 1;
            });

            $.each(rooms, function () {
                ui.addMessage(this.Name + ' (' + this.Count + ')', 'list-item');
            });
        }
    };

    chat.showCommands = function () {
        ui.addMessage('Help', 'list-header');
        $.each(ui.getCommands(), function () {
            ui.addMessage(this.Name + ' - ' + this.Description, 'list-item');
        });
    };

    chat.showUsersInRoom = function (room, names) {
        ui.addMessage('Users in ' + room, 'list-header');
        if (names.length === 0) {
            ui.addMessage('Room is empty', 'list-item');
        }
        else {
            $.each(names, function () {
                ui.addMessage('- ' + this, 'list-item');
            });
        }
    };

    chat.listUsers = function (users) {
        if (users.length === 0) {
            ui.addMessage('No users matched your search', 'list-header');
        }
        else {
            ui.addMessage('The following users match your search', 'list-header');
            ui.addMessage(users.join(', '), 'list-item');
        }
    };

    chat.showUsersRoomList = function (user, rooms) {
        if (rooms.length === 0) {
            ui.addMessage(user + ' is not in any rooms', 'list-header');
        }
        else {
            ui.addMessage(user + ' is in the following rooms', 'list-header');
            ui.addMessage(rooms.join(', '), 'list-item');
        }
    };

    chat.showUsersOwnedRoomList = function (user, rooms) {
        if (rooms.length === 0) {
            ui.addMessage(user + ' is not in any rooms', 'list-header');
        }
        else {
            ui.addMessage(user + ' owns the following rooms', 'list-header');
            ui.addMessage(rooms.join(', '), 'list-item');
        }
    };

    $ui.bind(ui.events.typing, function () {
        // If not in a room, don't try to send typing notifications
        if (!chat.activeRoom) {
            return;
        }

        // Clear any previous timeout
        if (typingTimeoutId) {
            clearTimeout(typingTimeoutId);
        }
        else {
            // Otherwise, mark as typing
            chat.typing(true);
        }

        // Set timeout to turn off
        typingTimeoutId = window.setTimeout(function () {
            typingTimeoutId = 0;
            chat.typing(false);
        }, 3000);
    });

    $ui.bind(ui.events.sendMessage, function (ev, msg) {
        chat.send(msg)
            .fail(function (e) {
                ui.addMessage(e, 'error');
            });

        clearTimeout(typingTimeoutId);
        typingTimeoutId = 0;
        chat.typing(false);

        // Store message history
        messageHistory.push(msg);

        // REVIEW: should this pop items off the top after a certain length?
        historyLocation = messageHistory.length;
    });

    $ui.bind(ui.events.focusit, function () {
        focus = true;
        unread = 0;
        updateTitle();
    });

    $ui.bind(ui.events.blurit, function () {
        focus = false;

        updateTitle();
    });

    $ui.bind(ui.events.openRoom, function (ev, room) {
        chat.send('/join ' + room)
            .fail(function (e) {
                ui.setActiveRoom('Lobby');
                ui.addMessage(e, 'error');
            });
    });

    $ui.bind(ui.events.closeRoom, function (ev, room) {
        chat.send('/leave ' + room)
            .fail(function (e) {
                ui.addMessage(e, 'error');
            });
    });

    $ui.bind(ui.events.prevMessage, function () {
        historyLocation -= 1;
        if (historyLocation < 0) {
            historyLocation = messageHistory.length - 1;
        }
        ui.setMessage(messageHistory[historyLocation]);
    });

    $ui.bind(ui.events.nextMessage, function () {
        historyLocation = (historyLocation + 1) % messageHistory.length;
        ui.setMessage(messageHistory[historyLocation]);
    });

    $ui.bind(ui.events.activeRoomChanged, function (ev, room) {
        if (room === 'Lobby') {
            populateLobbyRooms();

            // Remove the active room
            chat.activeRoom = undefined;
        }
        else {
            // When the active room changes update the client state and the cookie
            chat.activeRoom = room;
        }

        ui.scrollToBottom(room);
        updateCookie();
    });

    $ui.bind(ui.events.scrollRoomTop, function (ev, roomInfo) {
        // Do nothing if we're loading history already
        if (loadingHistory === true) {
            return;
        }

        loadingHistory = true;

        // TODO: Show a little animation so the user experience looks fancy
        chat.getPreviousMessages(roomInfo.messageId)
            .done(function (messages) {
                ui.prependChatMessages($.map(messages, getMessageViewModel), roomInfo.name);
                loadingHistory = false;
            })
            .fail(function () {
                loadingHistory = false;
            });
    });

    $(ui).bind(ui.events.preferencesChanged, function (ev) {
        updateCookie();
    });

    $(function () {
        var stateCookie = $.cookie('jabbr.state'),
            state = stateCookie ? JSON.parse(stateCookie) : {};

        // Initialize the ui, passing the user preferences
        ui.initialize(state.preferences);

        ui.addMessage('Welcome to ' + originalTitle, 'notification');
        ui.addMessage('Type /help to see the list of commands', 'notification');

        connection.hub.start(function () {
            chat.join()
                .fail(function (e) {
                    ui.addMessage(e, 'error');
                })
                .done(function (success) {
                    if (success === false) {
                        ui.addMessage('Choose a name using "/nick nickname password".', 'notification');
                    }
                    // get list of available commands
                    chat.getCommands()
                        .done(function (commands) {
                            ui.setCommands(commands);
                        });
                });
        });
    });

})(jQuery, $.connection, window, window.chat.ui);