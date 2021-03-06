// Copyright 2013, 2014, 2015, 2016 Kevin Reid <kpreid@switchb.org>
// 
// This file is part of ShinySDR.
// 
// ShinySDR is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
// 
// ShinySDR is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
// 
// You should have received a copy of the GNU General Public License
// along with ShinySDR.  If not, see <http://www.gnu.org/licenses/>.

define(['types', 'values', 'events', 'coordination', 'database', 'network', 'map/map-core', 'map/map-layers', 'widget', 'widgets', 'audio', 'window-manager', 'plugins'], (types, values, events, coordination, database, network, mapCore, mapLayers, widget, widgets, audio, windowManager, plugins) => {
  'use strict';
  
  function log(progressAmount, msg) {
    console.log(msg);
    document.getElementById('loading-information-text')
        .appendChild(document.createTextNode('\n' + msg));
    const progress = document.getElementById('loading-information-progress');
    progress.value += (1 - progress.value) * progressAmount;
  }
  
  const ClientStateObject = coordination.ClientStateObject;
  const ConstantCell = values.ConstantCell;
  const Context = widget.Context;
  const Coordinator = coordination.Coordinator;
  const DatabasePicker = database.DatabasePicker;
  const GeoMap = mapCore.GeoMap;
  const LocalCell = values.LocalCell;
  const Scheduler = events.Scheduler;
  const StorageNamespace = values.StorageNamespace;
  const Index = values.Index;
  const anyT = types.anyT;
  const connect = network.connect;
  const connectAudio = audio.connectAudio;
  const createWidgetExt = widget.createWidgetExt;
  const createWidgets = widget.createWidgets;
  const makeBlock = values.makeBlock;
  
  const scheduler = new Scheduler();

  var clientStateStorage = new StorageNamespace(localStorage, 'shinysdr.client.');
  
  const writableDB = database.fromURL('wdb/');
  const databasesCell = new LocalCell(anyT, database.systematics.concat([
    writableDB,  // kludge till we have proper UI for selection of write targets
  ]));
  database.arrayFromCatalog('dbs/', dbs => {   // TODO get url from server
    databasesCell.set(databasesCell.get().concat(dbs));
  });
  const databasePicker = new DatabasePicker(
    scheduler,
    databasesCell,
    new StorageNamespace(clientStateStorage, 'databases.'));
  const freqDB = databasePicker.getUnion();
  
  // TODO(kpreid): Client state should be more closely associated with the components that use it.
  const clientState = new ClientStateObject(clientStateStorage, databasePicker);
  const clientBlockCell = new ConstantCell(clientState);
  
  function main(stateUrl, audioUrl) {
    log(0.4, 'Loading plugins…');
    plugins.loadCSS();
    requirejs(plugins.getJSModuleIds(), function (plugins) {
      connectRadio(stateUrl, audioUrl);
    }, function (err) {
      log(0, 'Failed to load plugins.\n  ' + err.requireModules + '\n  ' + err.requireType);
      // TODO: There's no reason we can't continue without the plugin. The problem is that right now there's no good way to report the failure, and silent failures are bad.
    });
  }
  
  function connectRadio(stateUrl, audioUrl) {
    log(0.5, 'Connecting to server…');
    var firstConnection = true;
    var firstFailure = true;
    initialStateReady.scheduler = scheduler;
    var remoteCell = connect(stateUrl, connectionCallback);
    remoteCell.n.listen(initialStateReady);
    
    var coordinator = new Coordinator(scheduler, freqDB, remoteCell);
    
    var audioState = connectAudio(scheduler, audioUrl, new StorageNamespace(localStorage, 'shinysdr.audio.'));

    function connectionCallback(state) {
      switch (state) {
        case 'connected':
        if (firstConnection) {
          log(0.25, 'Downloading state…');
        }
          break;
        case 'disconnected':
          break;
        case 'failed-connect':
          if (firstConnection && firstFailure) {
            firstFailure = false;
            log(0, 'WebSocket connection failed (retrying).\nIf this persists, you may have a firewall/proxy problem.');
          }
          break;
      }
    }

    function initialStateReady() {
      // TODO: Is this necessary any more, or is it just a gratuitous rebuild? We're not depending on the value of the cell here.
      remoteCell.n.listen(initialStateReady);
      
      if (firstConnection) {
        firstConnection = false;
        
        const everything = new ConstantCell(makeBlock({
          client: clientBlockCell,
          radio: remoteCell,
          actions: new ConstantCell(coordinator.actions),
          audio: new ConstantCell(audioState)
        }));
      
        var index = new Index(scheduler, everything);
      
        var context = new Context({
          // TODO all of this should be narrowed down, read-only, replaced with other means to get it to the widgets that need it, etc.
          widgets: widgets,
          radioCell: remoteCell,
          index: index,
          clientState: clientState,
          spectrumView: null,
          freqDB: freqDB,
          writableDB: writableDB,
          scheduler: scheduler,
          coordinator: coordinator
        });
      
        // generic control UI widget tree
        createWidgets(everything, context, document);
        
        // Map (all geographic data)
        createWidgetExt(context, GeoMap, document.getElementById('map'), remoteCell);
      
        // Now that the widgets are live, show the full UI, with a tiny pause for progress display completion and in case of last-minute jank
        log(1.0, 'Ready.');
        setTimeout(function () {
          document.body.classList.remove('main-not-yet-run');
          
          // kludge to trigger js relayout effects. Needed here because main-not-yet-run hides ui.
          var resize = document.createEvent('Event');
          resize.initEvent('resize', false, false);
          window.dispatchEvent(resize);
        }, 100);
        
        // globals for debugging / interactive programming purposes only
        window.DfreqDB = freqDB;
        window.DwritableDB = writableDB;
        window.DradioCell = remoteCell;
        window.Deverything = everything;
        window.Dindex = index;
      }
    }
  }
  
  return main;
});