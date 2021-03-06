/*
 * Copyright (C) 2011 Google Inc. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are
 * met:
 *
 *     * Redistributions of source code must retain the above copyright
 * notice, this list of conditions and the following disclaimer.
 *     * Redistributions in binary form must reproduce the above
 * copyright notice, this list of conditions and the following disclaimer
 * in the documentation and/or other materials provided with the
 * distribution.
 *     * Neither the name of Google Inc. nor the names of its
 * contributors may be used to endorse or promote products derived from
 * this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
/**
 * @implements {SDK.TargetManager.Observer}
 * @unrestricted
 */
Bindings.BreakpointManager = class extends Common.Object {
  /**
   * @param {?Common.Setting} breakpointsSetting
   * @param {!Workspace.Workspace} workspace
   * @param {!SDK.TargetManager} targetManager
   * @param {!Bindings.DebuggerWorkspaceBinding} debuggerWorkspaceBinding
   */
  constructor(breakpointsSetting, workspace, targetManager, debuggerWorkspaceBinding) {
    super();
    this._storage = new Bindings.BreakpointManager.Storage(this, breakpointsSetting);
    this._workspace = workspace;
    this._targetManager = targetManager;
    this._debuggerWorkspaceBinding = debuggerWorkspaceBinding;

    this._breakpointsActive = true;
    /** @type {!Map<!Workspace.UISourceCode, !Map<number, !Map<number, !Array<!Bindings.BreakpointManager.Breakpoint>>>>} */
    this._breakpointsForUISourceCode = new Map();
    /** @type {!Map<!Workspace.UISourceCode, !Array<!Bindings.BreakpointManager.Breakpoint>>} */
    this._breakpointsForPrimaryUISourceCode = new Map();
    /** @type {!Multimap.<string, !Bindings.BreakpointManager.Breakpoint>} */
    this._provisionalBreakpoints = new Multimap();

    this._workspace.addEventListener(Workspace.Workspace.Events.ProjectRemoved, this._projectRemoved, this);
    this._workspace.addEventListener(Workspace.Workspace.Events.UISourceCodeAdded, this._uiSourceCodeAdded, this);
    this._workspace.addEventListener(Workspace.Workspace.Events.UISourceCodeRemoved, this._uiSourceCodeRemoved, this);

    targetManager.observeTargets(this, SDK.Target.Capability.JS);
  }

  /**
   * @param {string} sourceFileId
   * @param {number} lineNumber
   * @param {number} columnNumber
   * @return {string}
   */
  static _breakpointStorageId(sourceFileId, lineNumber, columnNumber) {
    if (!sourceFileId)
      return '';
    return sourceFileId + ':' + lineNumber + ':' + columnNumber;
  }

  /**
   * @param {!Workspace.UISourceCode} uiSourceCode
   * @return {string}
   */
  _sourceFileId(uiSourceCode) {
    // TODO(lushnikov): _sourceFileId is not needed any more.
    return uiSourceCode.url();
  }

  /**
   * @override
   * @param {!SDK.Target} target
   */
  targetAdded(target) {
    var debuggerModel = SDK.DebuggerModel.fromTarget(target);
    if (debuggerModel && !this._breakpointsActive)
      debuggerModel.setBreakpointsActive(this._breakpointsActive);
  }

  /**
   * @override
   * @param {!SDK.Target} target
   */
  targetRemoved(target) {
  }

  /**
   * @param {string} sourceFileId
   * @return {!Map.<string, !Bindings.BreakpointManager.Breakpoint>}
   */
  _provisionalBreakpointsForSourceFileId(sourceFileId) {
    var result = new Map();
    var breakpoints = this._provisionalBreakpoints.get(sourceFileId).valuesArray();
    for (var i = 0; i < breakpoints.length; ++i)
      result.set(breakpoints[i]._breakpointStorageId(), breakpoints[i]);
    return result;
  }

  removeProvisionalBreakpointsForTest() {
    var breakpoints = this._provisionalBreakpoints.valuesArray();
    for (var i = 0; i < breakpoints.length; ++i)
      breakpoints[i].remove();
    this._provisionalBreakpoints.clear();
  }

  /**
   * @param {!Workspace.UISourceCode} uiSourceCode
   */
  _restoreBreakpoints(uiSourceCode) {
    var sourceFileId = this._sourceFileId(uiSourceCode);
    if (!sourceFileId)
      return;

    this._storage.mute();
    var breakpointItems = this._storage.breakpointItems(this._sourceFileId(uiSourceCode));
    var provisionalBreakpoints = this._provisionalBreakpointsForSourceFileId(sourceFileId);
    for (var i = 0; i < breakpointItems.length; ++i) {
      var breakpointItem = breakpointItems[i];
      var itemStorageId = Bindings.BreakpointManager._breakpointStorageId(
          breakpointItem.sourceFileId, breakpointItem.lineNumber, breakpointItem.columnNumber);
      var provisionalBreakpoint = provisionalBreakpoints.get(itemStorageId);
      if (provisionalBreakpoint) {
        if (!this._breakpointsForPrimaryUISourceCode.get(uiSourceCode))
          this._breakpointsForPrimaryUISourceCode.set(uiSourceCode, []);
        this._breakpointsForPrimaryUISourceCode.get(uiSourceCode).push(provisionalBreakpoint);
        provisionalBreakpoint._updateBreakpoint();
      } else {
        this._innerSetBreakpoint(
            uiSourceCode, breakpointItem.lineNumber, breakpointItem.columnNumber, breakpointItem.condition,
            breakpointItem.enabled);
      }
    }
    this._provisionalBreakpoints.removeAll(sourceFileId);
    this._storage.unmute();
  }

  /**
   * @param {!Common.Event} event
   */
  _uiSourceCodeAdded(event) {
    var uiSourceCode = /** @type {!Workspace.UISourceCode} */ (event.data);
    this._restoreBreakpoints(uiSourceCode);
    if (uiSourceCode.contentType().hasScripts()) {
      uiSourceCode.addEventListener(
          Workspace.UISourceCode.Events.SourceMappingChanged, this._uiSourceCodeMappingChanged, this);
    }
  }

  /**
   * @param {!Common.Event} event
   */
  _uiSourceCodeRemoved(event) {
    var uiSourceCode = /** @type {!Workspace.UISourceCode} */ (event.data);
    this._removeUISourceCode(uiSourceCode);
  }

  /**
   * @param {!Common.Event} event
   */
  _uiSourceCodeMappingChanged(event) {
    var uiSourceCode = /** @type {!Workspace.UISourceCode} */ (event.target);
    var isIdentity = /** @type {boolean} */ (event.data.isIdentity);
    var target = /** @type {!SDK.Target} */ (event.data.target);
    if (isIdentity)
      return;
    var breakpoints = this._breakpointsForPrimaryUISourceCode.get(uiSourceCode) || [];
    for (var i = 0; i < breakpoints.length; ++i)
      breakpoints[i]._updateInDebuggerForTarget(target);
  }

  /**
   * @param {!Workspace.UISourceCode} uiSourceCode
   */
  _removeUISourceCode(uiSourceCode) {
    var breakpoints = this._breakpointsForPrimaryUISourceCode.get(uiSourceCode) || [];
    var sourceFileId = this._sourceFileId(uiSourceCode);
    for (var i = 0; i < breakpoints.length; ++i) {
      breakpoints[i]._resetLocations();
      if (breakpoints[i].enabled())
        this._provisionalBreakpoints.set(sourceFileId, breakpoints[i]);
    }
    uiSourceCode.removeEventListener(
        Workspace.UISourceCode.Events.SourceMappingChanged, this._uiSourceCodeMappingChanged, this);
    this._breakpointsForPrimaryUISourceCode.remove(uiSourceCode);
  }

  /**
   * @param {!Workspace.UISourceCode} uiSourceCode
   * @param {number} lineNumber
   * @param {number} columnNumber
   * @param {string} condition
   * @param {boolean} enabled
   * @return {!Bindings.BreakpointManager.Breakpoint}
   */
  setBreakpoint(uiSourceCode, lineNumber, columnNumber, condition, enabled) {
    var uiLocation = new Workspace.UILocation(uiSourceCode, lineNumber, columnNumber);
    var normalizedLocation = this._debuggerWorkspaceBinding.normalizeUILocation(uiLocation);
    if (normalizedLocation.id() !== uiLocation.id()) {
      Common.Revealer.reveal(normalizedLocation);
      uiLocation = normalizedLocation;
    }
    this.setBreakpointsActive(true);
    return this._innerSetBreakpoint(
        uiLocation.uiSourceCode, uiLocation.lineNumber, uiLocation.columnNumber, condition, enabled);
  }

  /**
   * @param {!Workspace.UISourceCode} uiSourceCode
   * @param {number} lineNumber
   * @param {number} columnNumber
   * @param {string} condition
   * @param {boolean} enabled
   * @return {!Bindings.BreakpointManager.Breakpoint}
   */
  _innerSetBreakpoint(uiSourceCode, lineNumber, columnNumber, condition, enabled) {
    var breakpoint = this.findBreakpoint(uiSourceCode, lineNumber, columnNumber);
    if (breakpoint) {
      breakpoint._updateState(condition, enabled);
      return breakpoint;
    }
    var projectId = uiSourceCode.project().id();
    var path = uiSourceCode.url();
    var sourceFileId = this._sourceFileId(uiSourceCode);
    breakpoint = new Bindings.BreakpointManager.Breakpoint(
        this, projectId, path, sourceFileId, lineNumber, columnNumber, condition, enabled);
    if (!this._breakpointsForPrimaryUISourceCode.get(uiSourceCode))
      this._breakpointsForPrimaryUISourceCode.set(uiSourceCode, []);
    this._breakpointsForPrimaryUISourceCode.get(uiSourceCode).push(breakpoint);
    return breakpoint;
  }

  /**
   * @param {!Workspace.UISourceCode} uiSourceCode
   * @param {number} lineNumber
   * @return {!Array<!Bindings.BreakpointManager.Breakpoint>}
   */
  findBreakpoints(uiSourceCode, lineNumber) {
    var breakpoints = this._breakpointsForUISourceCode.get(uiSourceCode);
    var lineBreakpoints = breakpoints ? breakpoints.get(lineNumber) : null;
    return lineBreakpoints ? lineBreakpoints.valuesArray()[0] : [];
  }

  /**
   * @param {!Workspace.UISourceCode} uiSourceCode
   * @param {number} lineNumber
   * @param {number} columnNumber
   * @return {?Bindings.BreakpointManager.Breakpoint}
   */
  findBreakpoint(uiSourceCode, lineNumber, columnNumber) {
    var breakpoints = this._breakpointsForUISourceCode.get(uiSourceCode);
    var lineBreakpoints = breakpoints ? breakpoints.get(lineNumber) : null;
    var columnBreakpoints = lineBreakpoints ? lineBreakpoints.get(columnNumber) : null;
    return columnBreakpoints ? columnBreakpoints[0] : null;
  }

  /**
   * @param {!Workspace.UISourceCode} uiSourceCode
   * @param {!Common.TextRange} textRange
   * @return {!Promise<!Array<!Workspace.UILocation>>}
   */
  possibleBreakpoints(uiSourceCode, textRange) {
    var targets = this._targetManager.targets(SDK.Target.Capability.JS);
    if (!targets.length)
      return Promise.resolve([]);
    for (var target of targets) {
      var startLocation = this._debuggerWorkspaceBinding.uiLocationToRawLocation(
          target, uiSourceCode, textRange.startLine, textRange.startColumn);
      if (!startLocation)
        continue;
      var endLocation = this._debuggerWorkspaceBinding.uiLocationToRawLocation(
          target, uiSourceCode, textRange.endLine, textRange.endColumn);
      if (!endLocation)
        continue;
      var debuggerModel = SDK.DebuggerModel.fromTarget(target);
      return debuggerModel.getPossibleBreakpoints(startLocation, endLocation).then(toUILocations.bind(this));
    }
    return Promise.resolve([]);

    /**
     * @this {!Bindings.BreakpointManager}
     * @param {!Array<!SDK.DebuggerModel.Location>} locations
     * @return {!Array<!Workspace.UILocation>}
     */
    function toUILocations(locations) {
      var sortedLocations = locations.map(location => this._debuggerWorkspaceBinding.rawLocationToUILocation(location));
      sortedLocations = sortedLocations.filter(location => location && location.uiSourceCode === uiSourceCode);
      sortedLocations.sort(Workspace.UILocation.comparator);
      if (!sortedLocations.length)
        return [];
      var result = [sortedLocations[0]];
      var lastLocation = sortedLocations[0];
      for (var i = 1; i < sortedLocations.length; ++i) {
        if (sortedLocations[i].id() === lastLocation.id())
          continue;
        result.push(sortedLocations[i]);
        lastLocation = sortedLocations[i];
      }
      return result;
    }
  }

  /**
   * @param {!Workspace.UISourceCode} uiSourceCode
   * @return {!Array.<!Bindings.BreakpointManager.Breakpoint>}
   */
  breakpointsForUISourceCode(uiSourceCode) {
    var result = [];
    var uiSourceCodeBreakpoints = this._breakpointsForUISourceCode.get(uiSourceCode);
    var breakpoints = uiSourceCodeBreakpoints ? uiSourceCodeBreakpoints.valuesArray() : [];
    for (var i = 0; i < breakpoints.length; ++i) {
      var lineBreakpoints = breakpoints[i];
      var columnBreakpointArrays = lineBreakpoints ? lineBreakpoints.valuesArray() : [];
      result = result.concat.apply(result, columnBreakpointArrays);
    }
    return result;
  }

  /**
   * @return {!Array.<!Bindings.BreakpointManager.Breakpoint>}
   */
  allBreakpoints() {
    var result = [];
    var uiSourceCodes = this._breakpointsForUISourceCode.keysArray();
    for (var i = 0; i < uiSourceCodes.length; ++i)
      result = result.concat(this.breakpointsForUISourceCode(uiSourceCodes[i]));
    return result;
  }

  /**
   * @param {!Workspace.UISourceCode} uiSourceCode
   * @return {!Array.<!{breakpoint: !Bindings.BreakpointManager.Breakpoint, uiLocation: !Workspace.UILocation}>}
   */
  breakpointLocationsForUISourceCode(uiSourceCode) {
    var uiSourceCodeBreakpoints = this._breakpointsForUISourceCode.get(uiSourceCode);
    var lineNumbers = uiSourceCodeBreakpoints ? uiSourceCodeBreakpoints.keysArray() : [];
    var result = [];
    for (var i = 0; i < lineNumbers.length; ++i) {
      var lineBreakpoints = uiSourceCodeBreakpoints.get(lineNumbers[i]);
      var columnNumbers = lineBreakpoints.keysArray();
      for (var j = 0; j < columnNumbers.length; ++j) {
        var columnBreakpoints = lineBreakpoints.get(columnNumbers[j]);
        var lineNumber = parseInt(lineNumbers[i], 10);
        var columnNumber = parseInt(columnNumbers[j], 10);
        for (var k = 0; k < columnBreakpoints.length; ++k) {
          var breakpoint = columnBreakpoints[k];
          var uiLocation = uiSourceCode.uiLocation(lineNumber, columnNumber);
          result.push({breakpoint: breakpoint, uiLocation: uiLocation});
        }
      }
    }
    return result;
  }

  /**
   * @return {!Array.<!{breakpoint: !Bindings.BreakpointManager.Breakpoint, uiLocation: !Workspace.UILocation}>}
   */
  allBreakpointLocations() {
    var result = [];
    var uiSourceCodes = this._breakpointsForUISourceCode.keysArray();
    for (var i = 0; i < uiSourceCodes.length; ++i)
      result = result.concat(this.breakpointLocationsForUISourceCode(uiSourceCodes[i]));
    return result;
  }

  /**
   * @param {boolean} toggleState
   */
  toggleAllBreakpoints(toggleState) {
    var breakpoints = this.allBreakpoints();
    for (var i = 0; i < breakpoints.length; ++i)
      breakpoints[i].setEnabled(toggleState);
  }

  removeAllBreakpoints() {
    var breakpoints = this.allBreakpoints();
    for (var i = 0; i < breakpoints.length; ++i)
      breakpoints[i].remove();
  }

  _projectRemoved(event) {
    var project = /** @type {!Workspace.Project} */ (event.data);
    var uiSourceCodes = project.uiSourceCodes();
    for (var i = 0; i < uiSourceCodes.length; ++i)
      this._removeUISourceCode(uiSourceCodes[i]);
  }

  /**
   * @param {!Bindings.BreakpointManager.Breakpoint} breakpoint
   * @param {boolean} removeFromStorage
   */
  _removeBreakpoint(breakpoint, removeFromStorage) {
    var uiSourceCode = breakpoint.uiSourceCode();
    var breakpoints = uiSourceCode ? this._breakpointsForPrimaryUISourceCode.get(uiSourceCode) || [] : [];
    breakpoints.remove(breakpoint);
    if (removeFromStorage)
      this._storage._removeBreakpoint(breakpoint);
    this._provisionalBreakpoints.remove(breakpoint._sourceFileId, breakpoint);
  }

  /**
   * @param {!Bindings.BreakpointManager.Breakpoint} breakpoint
   * @param {!Workspace.UILocation} uiLocation
   */
  _uiLocationAdded(breakpoint, uiLocation) {
    var breakpoints = this._breakpointsForUISourceCode.get(uiLocation.uiSourceCode);
    if (!breakpoints) {
      breakpoints = new Map();
      this._breakpointsForUISourceCode.set(uiLocation.uiSourceCode, breakpoints);
    }
    var lineBreakpoints = breakpoints.get(uiLocation.lineNumber);
    if (!lineBreakpoints) {
      lineBreakpoints = new Map();
      breakpoints.set(uiLocation.lineNumber, lineBreakpoints);
    }
    var columnBreakpoints = lineBreakpoints.get(uiLocation.columnNumber);
    if (!columnBreakpoints) {
      columnBreakpoints = [];
      lineBreakpoints.set(uiLocation.columnNumber, columnBreakpoints);
    }
    columnBreakpoints.push(breakpoint);
    this.dispatchEventToListeners(
        Bindings.BreakpointManager.Events.BreakpointAdded, {breakpoint: breakpoint, uiLocation: uiLocation});
  }

  /**
   * @param {!Bindings.BreakpointManager.Breakpoint} breakpoint
   * @param {!Workspace.UILocation} uiLocation
   */
  _uiLocationRemoved(breakpoint, uiLocation) {
    var breakpoints = this._breakpointsForUISourceCode.get(uiLocation.uiSourceCode);
    if (!breakpoints)
      return;

    var lineBreakpoints = breakpoints.get(uiLocation.lineNumber);
    if (!lineBreakpoints)
      return;
    var columnBreakpoints = lineBreakpoints.get(uiLocation.columnNumber);
    if (!columnBreakpoints)
      return;
    columnBreakpoints.remove(breakpoint);
    if (!columnBreakpoints.length)
      lineBreakpoints.remove(uiLocation.columnNumber);
    if (!lineBreakpoints.size)
      breakpoints.remove(uiLocation.lineNumber);
    if (!breakpoints.size)
      this._breakpointsForUISourceCode.remove(uiLocation.uiSourceCode);
    this.dispatchEventToListeners(
        Bindings.BreakpointManager.Events.BreakpointRemoved, {breakpoint: breakpoint, uiLocation: uiLocation});
  }

  /**
   * @param {boolean} active
   */
  setBreakpointsActive(active) {
    if (this._breakpointsActive === active)
      return;

    this._breakpointsActive = active;
    var debuggerModels = SDK.DebuggerModel.instances();
    for (var i = 0; i < debuggerModels.length; ++i)
      debuggerModels[i].setBreakpointsActive(active);

    this.dispatchEventToListeners(Bindings.BreakpointManager.Events.BreakpointsActiveStateChanged, active);
  }

  /**
   * @return {boolean}
   */
  breakpointsActive() {
    return this._breakpointsActive;
  }
};

/** @enum {symbol} */
Bindings.BreakpointManager.Events = {
  BreakpointAdded: Symbol('breakpoint-added'),
  BreakpointRemoved: Symbol('breakpoint-removed'),
  BreakpointsActiveStateChanged: Symbol('BreakpointsActiveStateChanged')
};


/**
 * @implements {SDK.TargetManager.Observer}
 * @unrestricted
 */
Bindings.BreakpointManager.Breakpoint = class {
  /**
   * @param {!Bindings.BreakpointManager} breakpointManager
   * @param {string} projectId
   * @param {string} path
   * @param {string} sourceFileId
   * @param {number} lineNumber
   * @param {number} columnNumber
   * @param {string} condition
   * @param {boolean} enabled
   */
  constructor(breakpointManager, projectId, path, sourceFileId, lineNumber, columnNumber, condition, enabled) {
    this._breakpointManager = breakpointManager;
    this._projectId = projectId;
    this._path = path;
    this._lineNumber = lineNumber;
    this._columnNumber = columnNumber;
    this._sourceFileId = sourceFileId;

    /** @type {!Map<string, number>} */
    this._numberOfDebuggerLocationForUILocation = new Map();

    // Force breakpoint update.
    /** @type {string} */ this._condition;
    /** @type {boolean} */ this._enabled;
    /** @type {boolean} */ this._isRemoved;
    /** @type {!Workspace.UILocation|undefined} */ this._fakePrimaryLocation;

    this._currentState = null;
    /** @type {!Map.<!SDK.Target, !Bindings.BreakpointManager.TargetBreakpoint>}*/
    this._targetBreakpoints = new Map();
    this._updateState(condition, enabled);
    this._breakpointManager._targetManager.observeTargets(this);
  }

  /**
   * @override
   * @param {!SDK.Target} target
   */
  targetAdded(target) {
    var debuggerModel = SDK.DebuggerModel.fromTarget(target);
    if (!debuggerModel)
      return;
    var debuggerWorkspaceBinding = this._breakpointManager._debuggerWorkspaceBinding;
    this._targetBreakpoints.set(
        target, new Bindings.BreakpointManager.TargetBreakpoint(debuggerModel, this, debuggerWorkspaceBinding));
  }

  /**
   * @override
   * @param {!SDK.Target} target
   */
  targetRemoved(target) {
    var debuggerModel = SDK.DebuggerModel.fromTarget(target);
    if (!debuggerModel)
      return;
    var targetBreakpoint = this._targetBreakpoints.remove(target);
    targetBreakpoint._cleanUpAfterDebuggerIsGone();
    targetBreakpoint._removeEventListeners();
  }

  /**
   * @return {string}
   */
  projectId() {
    return this._projectId;
  }

  /**
   * @return {string}
   */
  path() {
    return this._path;
  }

  /**
   * @return {number}
   */
  lineNumber() {
    return this._lineNumber;
  }

  /**
   * @return {number}
   */
  columnNumber() {
    return this._columnNumber;
  }

  /**
   * @return {?Workspace.UISourceCode}
   */
  uiSourceCode() {
    return this._breakpointManager._workspace.uiSourceCode(this._projectId, this._path);
  }

  /**
   * @param {?Workspace.UILocation} oldUILocation
   * @param {!Workspace.UILocation} newUILocation
   */
  _replaceUILocation(oldUILocation, newUILocation) {
    if (this._isRemoved)
      return;

    this._removeUILocation(oldUILocation, true);
    this._removeFakeBreakpointAtPrimaryLocation();

    var current = (this._numberOfDebuggerLocationForUILocation.get(newUILocation.id()) || 0) + 1;
    this._numberOfDebuggerLocationForUILocation.set(newUILocation.id(), current);
    if (current === 1)
      this._breakpointManager._uiLocationAdded(this, newUILocation);
  }

  /**
   * @param {?Workspace.UILocation} uiLocation
   * @param {boolean=} muteCreationFakeBreakpoint
   */
  _removeUILocation(uiLocation, muteCreationFakeBreakpoint) {
    if (!uiLocation || !this._numberOfDebuggerLocationForUILocation.has(uiLocation.id()))
      return;
    var current = (this._numberOfDebuggerLocationForUILocation.get(uiLocation.id()) || 0) - 1;
    this._numberOfDebuggerLocationForUILocation.set(uiLocation.id(), current);
    if (current !== 0)
      return;

    this._numberOfDebuggerLocationForUILocation.delete(uiLocation.id());
    this._breakpointManager._uiLocationRemoved(this, uiLocation);
    if (!muteCreationFakeBreakpoint)
      this._fakeBreakpointAtPrimaryLocation();
  }

  /**
   * @return {boolean}
   */
  enabled() {
    return this._enabled;
  }

  /**
   * @param {boolean} enabled
   */
  setEnabled(enabled) {
    this._updateState(this._condition, enabled);
  }

  /**
   * @return {string}
   */
  condition() {
    return this._condition;
  }

  /**
   * @param {string} condition
   */
  setCondition(condition) {
    this._updateState(condition, this._enabled);
  }

  /**
   * @param {string} condition
   * @param {boolean} enabled
   */
  _updateState(condition, enabled) {
    if (this._enabled === enabled && this._condition === condition)
      return;
    this._enabled = enabled;
    this._condition = condition;
    this._breakpointManager._storage._updateBreakpoint(this);
    this._updateBreakpoint();
  }

  _updateBreakpoint() {
    this._removeFakeBreakpointAtPrimaryLocation();
    this._fakeBreakpointAtPrimaryLocation();
    var targetBreakpoints = this._targetBreakpoints.valuesArray();
    for (var i = 0; i < targetBreakpoints.length; ++i)
      targetBreakpoints[i]._scheduleUpdateInDebugger();
  }

  /**
   * @param {boolean=} keepInStorage
   */
  remove(keepInStorage) {
    this._isRemoved = true;
    var removeFromStorage = !keepInStorage;
    this._removeFakeBreakpointAtPrimaryLocation();
    var targetBreakpoints = this._targetBreakpoints.valuesArray();
    for (var i = 0; i < targetBreakpoints.length; ++i) {
      targetBreakpoints[i]._scheduleUpdateInDebugger();
      targetBreakpoints[i]._removeEventListeners();
    }

    this._breakpointManager._removeBreakpoint(this, removeFromStorage);
    this._breakpointManager._targetManager.unobserveTargets(this);
  }

  /**
   * @param {!SDK.Target} target
   */
  _updateInDebuggerForTarget(target) {
    this._targetBreakpoints.get(target)._scheduleUpdateInDebugger();
  }

  /**
   * @return {string}
   */
  _breakpointStorageId() {
    return Bindings.BreakpointManager._breakpointStorageId(this._sourceFileId, this._lineNumber, this._columnNumber);
  }

  _fakeBreakpointAtPrimaryLocation() {
    if (this._isRemoved || this._numberOfDebuggerLocationForUILocation.size || this._fakePrimaryLocation)
      return;

    var uiSourceCode = this._breakpointManager._workspace.uiSourceCode(this._projectId, this._path);
    if (!uiSourceCode)
      return;

    this._fakePrimaryLocation = uiSourceCode.uiLocation(this._lineNumber, this._columnNumber);
    if (this._fakePrimaryLocation)
      this._breakpointManager._uiLocationAdded(this, this._fakePrimaryLocation);
  }

  _removeFakeBreakpointAtPrimaryLocation() {
    if (this._fakePrimaryLocation) {
      this._breakpointManager._uiLocationRemoved(this, this._fakePrimaryLocation);
      delete this._fakePrimaryLocation;
    }
  }

  _resetLocations() {
    this._removeFakeBreakpointAtPrimaryLocation();
    var targetBreakpoints = this._targetBreakpoints.valuesArray();
    for (var i = 0; i < targetBreakpoints.length; ++i)
      targetBreakpoints[i]._resetLocations();
  }
};

/**
 * @unrestricted
 */
Bindings.BreakpointManager.TargetBreakpoint = class extends SDK.SDKObject {
  /**
   * @param {!SDK.DebuggerModel} debuggerModel
   * @param {!Bindings.BreakpointManager.Breakpoint} breakpoint
   * @param {!Bindings.DebuggerWorkspaceBinding} debuggerWorkspaceBinding
   */
  constructor(debuggerModel, breakpoint, debuggerWorkspaceBinding) {
    super(debuggerModel.target());
    this._debuggerModel = debuggerModel;
    this._breakpoint = breakpoint;
    this._debuggerWorkspaceBinding = debuggerWorkspaceBinding;

    this._liveLocations = new Bindings.LiveLocationPool();

    /** @type {!Map<string, !Workspace.UILocation>} */
    this._uiLocations = new Map();
    this._debuggerModel.addEventListener(
        SDK.DebuggerModel.Events.DebuggerWasDisabled, this._cleanUpAfterDebuggerIsGone, this);
    this._debuggerModel.addEventListener(
        SDK.DebuggerModel.Events.DebuggerWasEnabled, this._scheduleUpdateInDebugger, this);
    this._hasPendingUpdate = false;
    this._isUpdating = false;
    this._cancelCallback = false;
    this._currentState = null;
    if (this._debuggerModel.debuggerEnabled())
      this._scheduleUpdateInDebugger();
  }

  _resetLocations() {
    for (var uiLocation of this._uiLocations.values())
      this._breakpoint._removeUILocation(uiLocation);

    this._uiLocations.clear();
    this._liveLocations.disposeAll();
  }

  _scheduleUpdateInDebugger() {
    if (this._isUpdating) {
      this._hasPendingUpdate = true;
      return;
    }

    this._isUpdating = true;
    this._updateInDebugger(this._didUpdateInDebugger.bind(this));
  }

  _didUpdateInDebugger() {
    this._isUpdating = false;
    if (this._hasPendingUpdate) {
      this._hasPendingUpdate = false;
      this._scheduleUpdateInDebugger();
    }
  }

  /**
   * @return {boolean}
   */
  _scriptDiverged() {
    var uiSourceCode = this._breakpoint.uiSourceCode();
    if (!uiSourceCode)
      return false;
    var scriptFile = this._debuggerWorkspaceBinding.scriptFile(uiSourceCode, this.target());
    return !!scriptFile && scriptFile.hasDivergedFromVM();
  }

  /**
   * @param {function()} callback
   */
  _updateInDebugger(callback) {
    if (this.target().isDisposed()) {
      this._cleanUpAfterDebuggerIsGone();
      callback();
      return;
    }

    var uiSourceCode = this._breakpoint.uiSourceCode();
    var lineNumber = this._breakpoint._lineNumber;
    var columnNumber = this._breakpoint._columnNumber;
    var condition = this._breakpoint.condition();

    var debuggerLocation = uiSourceCode ?
        this._debuggerWorkspaceBinding.uiLocationToRawLocation(this.target(), uiSourceCode, lineNumber, columnNumber) :
        null;
    var newState;
    if (this._breakpoint._isRemoved || !this._breakpoint.enabled() || this._scriptDiverged()) {
      newState = null;
    } else if (debuggerLocation) {
      var script = debuggerLocation.script();
      if (script.sourceURL) {
        newState = new Bindings.BreakpointManager.Breakpoint.State(
            script.sourceURL, null, debuggerLocation.lineNumber, debuggerLocation.columnNumber, condition);
      } else {
        newState = new Bindings.BreakpointManager.Breakpoint.State(
            null, debuggerLocation.scriptId, debuggerLocation.lineNumber, debuggerLocation.columnNumber, condition);
      }
    } else if (this._breakpoint._currentState && this._breakpoint._currentState.url) {
      var position = this._breakpoint._currentState;
      newState = new Bindings.BreakpointManager.Breakpoint.State(
          position.url, null, position.lineNumber, position.columnNumber, condition);
    } else if (uiSourceCode) {
      newState = new Bindings.BreakpointManager.Breakpoint.State(
          uiSourceCode.url(), null, lineNumber, columnNumber, condition);
    }
    if (this._debuggerId && Bindings.BreakpointManager.Breakpoint.State.equals(newState, this._currentState)) {
      callback();
      return;
    }

    this._breakpoint._currentState = newState;

    if (this._debuggerId) {
      this._resetLocations();
      this._debuggerModel.removeBreakpoint(this._debuggerId, this._didRemoveFromDebugger.bind(this, callback));
      this._scheduleUpdateInDebugger();
      this._currentState = null;
      return;
    }

    if (!newState) {
      callback();
      return;
    }

    var updateCallback = this._didSetBreakpointInDebugger.bind(this, callback);
    if (newState.url) {
      this._debuggerModel.setBreakpointByURL(
          newState.url, newState.lineNumber, newState.columnNumber, this._breakpoint.condition(), updateCallback);
    } else if (newState.scriptId) {
      this._debuggerModel.setBreakpointBySourceId(
          /** @type {!SDK.DebuggerModel.Location} */ (debuggerLocation), condition, updateCallback);
    }

    this._currentState = newState;
  }

  /**
   * @param {function()} callback
   * @param {?Protocol.Debugger.BreakpointId} breakpointId
   * @param {!Array.<!SDK.DebuggerModel.Location>} locations
   */
  _didSetBreakpointInDebugger(callback, breakpointId, locations) {
    if (this._cancelCallback) {
      this._cancelCallback = false;
      callback();
      return;
    }

    if (!breakpointId) {
      this._breakpoint.remove(true);
      callback();
      return;
    }

    this._debuggerId = breakpointId;
    this._debuggerModel.addBreakpointListener(this._debuggerId, this._breakpointResolved, this);
    for (var i = 0; i < locations.length; ++i) {
      if (!this._addResolvedLocation(locations[i]))
        break;
    }
    callback();
  }

  /**
   * @param {function()} callback
   */
  _didRemoveFromDebugger(callback) {
    if (this._cancelCallback) {
      this._cancelCallback = false;
      callback();
      return;
    }

    this._resetLocations();
    this._debuggerModel.removeBreakpointListener(this._debuggerId, this._breakpointResolved, this);
    delete this._debuggerId;
    callback();
  }

  /**
   * @param {!Common.Event} event
   */
  _breakpointResolved(event) {
    this._addResolvedLocation(/** @type {!SDK.DebuggerModel.Location}*/ (event.data));
  }

  /**
   * @param {!SDK.DebuggerModel.Location} location
   * @param {!Bindings.LiveLocation} liveLocation
   */
  _locationUpdated(location, liveLocation) {
    var uiLocation = liveLocation.uiLocation();
    if (!uiLocation)
      return;
    var oldUILocation = this._uiLocations.get(location.id()) || null;
    this._uiLocations.set(location.id(), uiLocation);
    this._breakpoint._replaceUILocation(oldUILocation, uiLocation);
  }

  /**
   * @param {!SDK.DebuggerModel.Location} location
   * @return {boolean}
   */
  _addResolvedLocation(location) {
    var uiLocation = this._debuggerWorkspaceBinding.rawLocationToUILocation(location);
    var breakpoint = this._breakpoint._breakpointManager.findBreakpoint(
        uiLocation.uiSourceCode, uiLocation.lineNumber, uiLocation.columnNumber);
    if (breakpoint && breakpoint !== this._breakpoint) {
      // location clash
      this._breakpoint.remove();
      return false;
    }
    this._debuggerWorkspaceBinding.createLiveLocation(
        location, this._locationUpdated.bind(this, location), this._liveLocations);
    return true;
  }

  _cleanUpAfterDebuggerIsGone() {
    if (this._isUpdating)
      this._cancelCallback = true;

    this._resetLocations();
    this._currentState = null;
    if (this._debuggerId)
      this._didRemoveFromDebugger(function() {});
  }

  _removeEventListeners() {
    this._debuggerModel.removeEventListener(
        SDK.DebuggerModel.Events.DebuggerWasDisabled, this._cleanUpAfterDebuggerIsGone, this);
    this._debuggerModel.removeEventListener(
        SDK.DebuggerModel.Events.DebuggerWasEnabled, this._scheduleUpdateInDebugger, this);
  }
};

/**
 * @unrestricted
 */
Bindings.BreakpointManager.Breakpoint.State = class {
  /**
   * @param {?string} url
   * @param {?string} scriptId
   * @param {number} lineNumber
   * @param {number} columnNumber
   * @param {string} condition
   */
  constructor(url, scriptId, lineNumber, columnNumber, condition) {
    this.url = url;
    this.scriptId = scriptId;
    this.lineNumber = lineNumber;
    this.columnNumber = columnNumber;
    this.condition = condition;
  }

  /**
   * @param {?Bindings.BreakpointManager.Breakpoint.State|undefined} stateA
   * @param {?Bindings.BreakpointManager.Breakpoint.State|undefined} stateB
   * @return {boolean}
   */
  static equals(stateA, stateB) {
    if (!stateA || !stateB)
      return false;

    if (stateA.scriptId || stateB.scriptId)
      return false;

    return stateA.url === stateB.url && stateA.lineNumber === stateB.lineNumber &&
        stateA.columnNumber === stateB.columnNumber && stateA.condition === stateB.condition;
  }
};


/**
 * @unrestricted
 */
Bindings.BreakpointManager.Storage = class {
  /**
   * @param {!Bindings.BreakpointManager} breakpointManager
   * @param {?Common.Setting} setting
   */
  constructor(breakpointManager, setting) {
    this._breakpointManager = breakpointManager;
    this._setting = setting || Common.settings.createLocalSetting('breakpoints', []);
    var breakpoints = this._setting.get();
    /** @type {!Object.<string, !Bindings.BreakpointManager.Storage.Item>} */
    this._breakpoints = {};
    for (var i = 0; i < breakpoints.length; ++i) {
      var breakpoint = /** @type {!Bindings.BreakpointManager.Storage.Item} */ (breakpoints[i]);
      breakpoint.columnNumber = breakpoint.columnNumber || 0;
      this._breakpoints[breakpoint.sourceFileId + ':' + breakpoint.lineNumber + ':' + breakpoint.columnNumber] =
          breakpoint;
    }
  }

  mute() {
    this._muted = true;
  }

  unmute() {
    delete this._muted;
  }

  /**
   * @param {string} sourceFileId
   * @return {!Array.<!Bindings.BreakpointManager.Storage.Item>}
   */
  breakpointItems(sourceFileId) {
    var result = [];
    for (var id in this._breakpoints) {
      var breakpoint = this._breakpoints[id];
      if (breakpoint.sourceFileId === sourceFileId)
        result.push(breakpoint);
    }
    return result;
  }

  /**
   * @param {!Bindings.BreakpointManager.Breakpoint} breakpoint
   */
  _updateBreakpoint(breakpoint) {
    if (this._muted || !breakpoint._breakpointStorageId())
      return;
    this._breakpoints[breakpoint._breakpointStorageId()] = new Bindings.BreakpointManager.Storage.Item(breakpoint);
    this._save();
  }

  /**
   * @param {!Bindings.BreakpointManager.Breakpoint} breakpoint
   */
  _removeBreakpoint(breakpoint) {
    if (this._muted)
      return;
    delete this._breakpoints[breakpoint._breakpointStorageId()];
    this._save();
  }

  _save() {
    var breakpointsArray = [];
    for (var id in this._breakpoints)
      breakpointsArray.push(this._breakpoints[id]);
    this._setting.set(breakpointsArray);
  }
};

/**
 * @unrestricted
 */
Bindings.BreakpointManager.Storage.Item = class {
  /**
   * @param {!Bindings.BreakpointManager.Breakpoint} breakpoint
   */
  constructor(breakpoint) {
    this.sourceFileId = breakpoint._sourceFileId;
    this.lineNumber = breakpoint.lineNumber();
    this.columnNumber = breakpoint.columnNumber();
    this.condition = breakpoint.condition();
    this.enabled = breakpoint.enabled();
  }
};

/** @type {!Bindings.BreakpointManager} */
Bindings.breakpointManager;
