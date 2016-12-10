# Copyright 2016 Kevin Reid <kpreid@switchb.org>
# 
# This file is part of ShinySDR.
# 
# ShinySDR is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
# 
# ShinySDR is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
# 
# You should have received a copy of the GNU General Public License
# along with ShinySDR.  If not, see <http://www.gnu.org/licenses/>.

"""Tools for persisting ExportedState state to disk."""

from __future__ import absolute_import, division

import json
import os.path
import shutil

from twisted.python import log

from shinysdr.values import ExportedState, SubscriptionContext


_PERSISTENCE_DELAY = 0.5


def _no_defaults(_root):
    return {}


# TODO: Think about a better name. The better name must not include "Manager".
# This is a class because I expect that it will have methods to control it in more detail in the future.
class PersistenceFileGlue(object):
    def __init__(self, reactor, root_object, filename, get_defaults=_no_defaults):
        """
        root_object: Object to persist.
        filename: path to state file to read/write, or None to not actually do persistence.
        get_defaults: function accepting root_object and returning state dict to use if file does not exist.
        """
        assert isinstance(root_object, ExportedState)
        
        self.__reactor = reactor
        self.__filename = filename
        self.__delayed_write_call = None
        
        if filename is None:
            self.__pcd = None
            self.__scheduled = False
            return
        
        if os.path.isfile(filename):
            root_object.state_from_json(json.load(open(filename, 'r')))
            # make a backup in case this code version misreads the state and loses things on save (but only if the load succeeded, in case the file but not its backup is bad)
            shutil.copyfile(filename, filename + '~')
        else:
            root_object.state_from_json(get_defaults(root_object))
        
        self.__pcd = PersistenceChangeDetector(root_object, self.__write_later,
            SubscriptionContext(reactor=reactor, poller=None))
        
        # Start implicit write-to-disk loop, but don't actually write.
        # This is because it is useful in some failure modes to not immediately overwrite a good state file with a bad one on startup.
        self.__pcd.get()
    
    def __write_later(self):
        # TODO: Surely there is some utility in Twisted to do this better.
        if not (self.__delayed_write_call and self.__delayed_write_call.active()):
            # TODO: factor out the logging?
            log.msg('Scheduling state write.')
            self.__delayed_write_call = self.__reactor.callLater(_PERSISTENCE_DELAY, self.__write_immediately)
    
    def __write_immediately(self):
        log.msg('Performing state write...')
        current_state = self.__pcd.get()
        with open(self.__filename, 'w') as f:
            json.dump(current_state, f)
        log.msg('...done')
        if self.__delayed_write_call and self.__delayed_write_call.active():
            self.__delayed_write_call.cancel()


class PersistenceChangeDetector(object):
    """Wrap state_to_json() so as to be notified when its result would change.
    
    root_object: Object to call .state_to_json() on.
    callback: Called exactly once after each .get() when the result changes.
    """
    
    # This is not itself a cell because we want to be able to be lazy and not do the potentially expensive state_to_json() immediately every time there is a change, whereas subscribe2 requires that the callback be given the current value. TODO revisit.
    
    def __init__(self, root_object, callback, subscription_context):
        assert isinstance(root_object, ExportedState)
        self.__root = root_object
        self.__callback = callback
        self.__subscription_context = subscription_context
        self.__subscriptions = []
    
    def get(self):
        self.__clear_subscriptions()
        return self.__root.state_to_json(subscriber=self.__add_subscription)
    
    def __clear_subscriptions(self):
        subs = self.__subscriptions
        self.__subscriptions = []
        for subscription in subs:
            subscription.unsubscribe()
    
    def __add_subscription(self, subscribe_fn):
        # TODO: It would be a reasonable strengthening to arrange so that even if the subscriptions misbehave, we do not ever 
        self.__subscriptions.append(subscribe_fn(self.__do_callback, self.__subscription_context))
    
    def __do_callback(self, _value):
        # ignore value because it is from an arbitrary element
        self.__clear_subscriptions()
        self.__callback()


