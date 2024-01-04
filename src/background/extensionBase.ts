const enum ButtonState { start, stop, fixtimer, connect }
const invalidProfileError = 'Profile not configured';

abstract class ExtensionBase extends BackgroundBase<SignalRConnection> {

    private _lastNotificationId: string;

    private _buttonState = ButtonState.start;

    private _loginTabId: number | undefined;

    private _loginWinId: number | undefined;

    private _loginWindowPending: boolean;

    private _extraHours: Promise<number>;

    private _timeEntries: Models.TimeEntry[];

    private _actionOnConnect: (() => void) | undefined;

    private static async getUrl(key: string) {
        let url = await storage.getItem(key);
        if (!url) {
            return;
        }
        if (url[url.length - 1] != '/') {
            url += '/';
        }
        return url;
    }

    private static async getConstants(browserSchema: string, extensionUUID: string) {
        return {
            maxTimerHours: 12,
            serviceUrl: await this.getUrl('tmetric.url') || 'https://app.tmetric.com/',
            storageUrl: await this.getUrl('tmetric.storageUrl') || 'https://services.tmetric.com/storage/',
            authorityUrl: await this.getUrl('tmetric.authorityUrl') || 'https://id.tmetric.com/',
            extensionName: chrome.runtime.getManifest().name,
            browserSchema,
            extensionUUID
        } as Models.Constants;
    }

    private static async getConnectionOptions(constants: Promise<Models.Constants>) {
        const signalRUrl = await this.getUrl('tmetric.signalRUrl') || 'https://services.tmetric.com/signalr/';
        const { serviceUrl, authorityUrl } = await constants;
        return { serviceUrl, authorityUrl, signalRUrl };
    }

    constructor(browserSchema: string, extensionUUID: string) {

        super(
            ExtensionBase.getConstants(browserSchema, extensionUUID),
            constants => new SignalRConnection(ExtensionBase.getConnectionOptions(constants)));

        this._extraHours = (async () => {
            const extraHours = await storage.getItem('tmetric.extraHours');
            return extraHours ? parseFloat(extraHours) : 0
        })();

        this.listenPopupAction<void, boolean>('isConnectionRetryEnabled', this.isConnectionRetryEnabledPopupAction);
        this.listenPopupAction<void, void>('retry', this.retryConnectionPopupAction);

        this.updateState();

        this._connection.onUpdateTimer(async timer => {

            // looks like disconnect
            if (timer == null) {
                this.clearIssuesDurationsCache();
            }

            this.timer = timer;

            if (timer && timer.details) {
                const project = await this.getProject(timer.details.projectId);
                timer.projectName = project && project.projectName;
            }

            this.updateState();
            this.sendToTabs({ action: 'setTimer', data: timer });

            // timer should be received from server on connect
            if (timer) {
                const action = this._actionOnConnect;
                if (action) {
                    this._actionOnConnect = undefined;
                    action();
                }
            }
        });

        this._connection.onUpdateTracker(timeEntries => {
            this._timeEntries = timeEntries;
            this.updateState();
        });

        this._connection.onUpdateProfile(profile => {
            this.userProfile = profile;
        });

        this._connection.onUpdateActiveAccount(() => {
            this.clearIssuesDurationsCache();
        });

        this._connection.onInvalidateAccountScopeCache(accountId => {
            this.invalidateAccountScopeCache(accountId);
        });

        this._connection.onRemoveExternalIssuesDurations(identifiers => {
            this.removeIssuesDurationsFromCache(identifiers);
        });

        this.registerInstallListener();

        this.registerStorageListener();

        this.registerTabsRemoveListener();

        this.contentScriptRegistrator.register();

        // Update hint once per minute
        const setUpdateTimeout = () => setTimeout(() => {
            this.updateState();
            setUpdateTimeout();
        }, (60 - new Date().getSeconds()) * 1000);

        setUpdateTimeout();
    }

    /**
     * Show push notification
     * @param message
     * @param title
     */
    protected override showNotification(message: string, title?: string) {
        if (this._lastNotificationId) {
            chrome.notifications.clear(this._lastNotificationId, () => { });
        }
        title = title || 'TMetric';
        const type = 'basic';
        const iconUrl = 'images/icon80.png';
        chrome.notifications.create(
            '',
            { title, message, type, iconUrl },
            id => this._lastNotificationId = id);
    }

    protected override isLongTimer() {
        return this._buttonState == ButtonState.fixtimer;
    }

    protected override async shouldShowPopup(
        timer: WebToolIssueTimer,
        scope: Models.AccountScope,
        status: Models.IntegratedProjectStatus) {

        const matchedProjectCount = this.getTrackedProjects(scope).filter(p => p.projectName == timer.projectName).length;
        const requiredFields = scope.requiredFields;

        const settings = await chrome.storage.sync.get(<IExtensionSettings>{ showPopup: Models.ShowPopupOption.Always });
        let showPopup = (settings as IExtensionSettings).showPopup || Models.ShowPopupOption.Always;

        if (timer.serviceType === 'Shortcut') {
            // TODO: popup is not working on Shortcut pages (TMET-7517)
            showPopup = Models.ShowPopupOption.Never;
        } else if (requiredFields.taskLink && !timer.issueUrl) {
            showPopup = Models.ShowPopupOption.Never;
        } else if (
            requiredFields.description && !timer.issueName && !timer.description ||
            requiredFields.project && !matchedProjectCount ||
            requiredFields.tags && (!timer.tagNames || !timer.tagNames.length)
        ) {
            showPopup = Models.ShowPopupOption.Always;
        }

        if (showPopup == Models.ShowPopupOption.Never) {
            return false;
        }

        return showPopup == Models.ShowPopupOption.Always ||
            !timer.projectName ||
            status.projectStatus == null ||
            matchedProjectCount > 1;
    }

    protected override putData<T>(data: T, action: (data: T) => Promise<any>, retryAction?: (data: T) => Promise<any>) {

        const onFail = (status: AjaxStatus | string, showDialog: boolean) => {

            this._actionOnConnect = undefined;

            if (status == invalidProfileError && showDialog) {
                this._constants.then(constants => chrome.tabs.create({ url: constants.serviceUrl }));
            }
            // Zero status when server is unavailable or certificate fails (#59755). Show dialog in that case too.
            else if (!status
                || typeof (status) === 'string'
                || status.statusCode == HttpStatusCode.Unauthorized
                || status.statusCode == 0) {

                const disconnectPromise = this._connection.disconnect();
                if (showDialog) {
                    disconnectPromise.then(() => {
                        this._actionOnConnect = () => onConnect(false);
                        this.showLoginDialog();
                    });
                }
            }
            else {

                const error = this.getErrorText(status);

                if (status.statusCode == HttpStatusCode.Forbidden && retryAction) {
                    const promise = retryAction(data);
                    if (promise) {
                        promise.catch(() => this.showError(error));
                        return;
                    }
                }

                this.showError(error);
            }
        };

        const onConnect = (showDialog: boolean) => {

            if (this.isLongTimer()) {

                // ensure connection before page open to prevent login duplication (#67759)
                this._actionOnConnect = () => this.fixTimer();
                this._connection.getData().catch(status => onFail(status, showDialog));
                return;
            }

            action(data).catch(status => onFail(status, showDialog));
        };

        if (this.timer == null) {
            // connect before action to get actual state
            this._actionOnConnect = () => onConnect(true);
            this._connection.reconnect().catch(status => onFail(status, true));
        }
        else {
            onConnect(true);
        }
    }

    protected sendToTabs(message: ITabMessage, tabId?: number) {

        if (tabId != null) {
            chrome.tabs.sendMessage(tabId, message);
            return;
        }

        chrome.tabs.query({}, tabs => tabs && tabs.forEach(tab => {
            if (tab.id != null && tab.url && tab.url.startsWith('http')) {
                chrome.tabs.sendMessage(tab.id, message, () => {

                    // Ignore errors in broadcast messages
                    const error = chrome.runtime.lastError;
                    if (error) {
                        console.log(`${message.action}: ${error.message}`)
                    }
                });
            }
        }));
    }

    protected override async getActiveTabTitle() {
        const tabs = await chrome.tabs.query({ currentWindow: true, active: true });
        const activeTab = tabs && tabs[0];
        return activeTab?.title || null;
    }

    protected getActiveTabId() {
        return new Promise<number | null>((resolve) => {
            chrome.tabs.query({ currentWindow: true, active: true },
                function (tabs) {
                    const activeTab = tabs && tabs[0];
                    const id = activeTab?.id || null;
                    resolve(id);
                });
        });
    }

    protected async getActiveTabPossibleWebTool() {

        const url = await this.getActiveTabUrl();
        const origin = WebToolManager.toOrigin(url);
        if (!origin) {
            return;
        }

        if (await WebToolManager.isAllowed([origin])) {
            return;
        }

        const isMatchUrl = (origin: string) => WebToolManager.isMatch(url, origin);

        const webTools = getWebToolDescriptions();
        const webTool = webTools.find(webTool => webTool.origins.some(isMatchUrl));
        if (webTool) {
            return <WebToolInfo>{
                serviceType: webTool.serviceType,
                serviceName: webTool.serviceName,
                origins: webTool.allOriginsRequired ? webTool.origins : [origin]
            };
        }
    }

    protected override openPage(url: string) {

        chrome.tabs.query({ active: true, windowId: chrome.windows.WINDOW_ID_CURRENT }, tabs => {

            const currentWindowId = tabs && tabs.length && tabs[0].windowId;

            // chrome.tabs.query do not support tab search with hashed urls
            // https://developer.chrome.com/extensions/match_patterns
            chrome.tabs.query({ url: url.split('#')[0] + '*' }, tabs => {
                // filter tabs queried without hashes by actual url
                const pageTabs = tabs && tabs.filter(tab => tab.url == url);
                if (pageTabs && pageTabs.length) {

                    let
                        anyWindowTab,
                        anyWindowActiveTab,
                        currentWindowTab,
                        currentWindowActiveTab: chrome.tabs.Tab | undefined;
                    for (let index = 0, size = pageTabs.length; index < size; index += 1) {
                        anyWindowTab = pageTabs[index];
                        if (anyWindowTab.active) {
                            anyWindowActiveTab = anyWindowTab;
                        }
                        if (anyWindowTab.windowId == currentWindowId) {
                            currentWindowTab = anyWindowTab;
                            if (currentWindowTab.active) {
                                currentWindowActiveTab = currentWindowTab;
                            }
                        }
                    }

                    const tabToActivate = currentWindowActiveTab || currentWindowTab || anyWindowActiveTab || anyWindowTab;
                    chrome.windows.update(tabToActivate.windowId, { focused: true });
                    chrome.tabs.update(tabToActivate.id, { active: true });
                } else {
                    chrome.tabs.create({ active: true, windowId: currentWindowId, url });
                }
            });
        });
    }

    protected override async reconnect(showLoginDialog: boolean) {
        try {
            await this._connection.reconnect();

            const key = 'skipPermissionsSetup';
            const skipPermissionsSetup = await new Promise<boolean>(resolve =>
                chrome.storage.local.get([key], result => resolve(result[key]))
            );

            if (!skipPermissionsSetup) {
                chrome.storage.local.set({ [key]: true });
                const url = chrome.runtime.getURL('permissions/check.html');
                chrome.tabs.create({ url, active: true });
            }
        }
        catch (err) {
            const constants = await this._constants;
            if (err === invalidProfileError) {
                chrome.tabs.create({ url: constants.serviceUrl });
            } else if (showLoginDialog) {
                this.showLoginDialog();
            }
        }
    }

    protected override registerMessageListener() {

        chrome.runtime.onMessageExternal.addListener((message: ITabMessage, _sender, sendResponse) => {
            switch (message.action) {
                case 'ping':
                    sendResponse('pong');
                    break;
            }
        });

        chrome.runtime.onMessage.addListener((
            message: ITabMessage | IPopupRequest | IExtensionSettingsMessage,
            sender: chrome.runtime.MessageSender,
            senderResponse: (IPopupResponse) => void
        ) => {

            console.log(message, sender)

            // Popup requests
            if (!sender.url || sender.url.startsWith(chrome.runtime.getURL('popup'))) {
                this.onPopupRequest(message, senderResponse);
                return !!senderResponse;
            }

            if (sender.url?.startsWith(chrome.runtime.getURL('permissions')) ||
                sender.url?.startsWith(chrome.runtime.getURL('settings'))) {

                this.onPermissionsMessage(message, senderResponse);
                return !!senderResponse;
            }

            if (!sender.tab) {
                return;
            }

            // Ignore login dialog
            if (sender.tab.id == this._loginTabId) {
                return;
            }

            // Tab page requests
            const tabId = sender.tab.id;
            if (tabId != null) {
                this.onTabMessage(message, tabId);
            }

            senderResponse(null);
        });
    }

    protected override openOptionsPagePopupAction() {
        this.openOptionsPageUrl()
        return Promise.resolve(null);
    }

    protected override showPopup(tabId?: number): void {
        this.sendToTabs({ action: 'showPopup' }, tabId);
    }

    protected override hidePopup(tabId?: number): void {
        this.sendToTabs({ action: 'hidePopup' }, tabId);
    }

    protected override async initializePopupAction(params: IPopupParams) {

        // Forget about old action when user open popup again
        this._actionOnConnect = undefined;
        if (!this.timer && this._connection.canRetryConnection) {
            await this._connection.retryConnection(true);
        }
        if (this.timer) {
            return await this.getPopupData(params);
        }
        throw 'Not connected';
    }

    /** Handles messages from in-page scripts */
    private async onTabMessage(message: ITabMessage, tabId: number) {

        this.sendToTabs({ action: message.action + '_callback' }, tabId);

        switch (message.action) {

            case 'getConstants':
                const constants = await this._constants;
                this.sendToTabs({ action: 'setConstants', data: constants }, tabId);
                break;

            case 'getTimer':
                this.sendToTabs({ action: 'setTimer', data: this.timer }, tabId);
                break;

            case 'putTimer':
                this.putExternalTimer(message.data, undefined, tabId);
                break;

            case 'getIssuesDurations':
                const durations = await this.getIssuesDurations(message.data);
                const extraHours = await this._extraHours;

                // show extra time on link for test purposes
                if (extraHours && this.timer && this.timer.isStarted) {
                    const activeDetails = this.timer.details;
                    if (activeDetails && activeDetails.projectTask) {
                        const activeTask = activeDetails.projectTask;
                        for (let i = 0; i < durations.length; i++) {
                            let duration = durations[i];
                            if (duration.issueUrl == activeTask.relativeIssueUrl && duration.serviceUrl == activeTask.integrationUrl) {
                                duration = JSON.parse(JSON.stringify(duration));
                                duration.duration += extraHours * 3600000;
                                durations[i] = duration;
                                break;
                            }
                        }
                    }
                }

                this.sendToTabs({ action: 'setIssuesDurations', data: durations }, tabId);
                break;
        }
    }

    private updateState() {
        this._constants.then(constants => {
            let state = ButtonState.connect;
            let text = 'Not Connected';
            if (this.timer) {
                const todayTotal = 'Today Total - '
                    + this.durationToString(this.getDuration(this._timeEntries))
                    + ' hours';
                if (this.timer.isStarted) {

                    if (this.getDuration(this.timer) > constants.maxTimerHours * 60 * 60000) {
                        state = ButtonState.fixtimer;
                        text = 'Started\nYou need to fix long-running timer';
                    }
                    else {
                        state = ButtonState.stop;
                        const description = this.timer.details.description || '(No task description)';
                        text = `Started (${todayTotal})\n${description}`;
                    }
                }
                else {
                    state = ButtonState.start;
                    text = 'Paused\n' + todayTotal;
                }
            }
            this._buttonState = state;
            this.setButtonIcon(state == ButtonState.stop || state == ButtonState.fixtimer ? 'active' : 'inactive', text);
        });
    }

    private getDuration(timer: Models.Timer): number
    private getDuration(timeEntries: Models.TimeEntry[]): number
    private getDuration(arg: any): any {
        if (arg) {
            const now = new Date().getTime();
            if ((<Models.TimeEntry[]>arg).reduce) {
                return (<Models.TimeEntry[]>arg).reduce((duration, entry) => {
                    const startTime = Date.parse(entry.startTime);
                    const endTime = entry.endTime ? Date.parse(entry.endTime) : now;
                    return duration + (endTime - startTime);
                }, 0);
            }
            else if ((<Models.Timer>arg).isStarted) {
                return now - Date.parse((<Models.Timer>arg).startTime);
            }
        }
        return 0;
    }

    private durationToString(duration: number) {

        let sign = '';
        if (duration < 0) {
            duration = -duration;
            sign = '-';
        }

        const totalMinutes = Math.floor(duration / 60000);
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;

        return sign + hours + (minutes < 10 ? ':0' : ':') + minutes;
    }

    // issues durations cache

    private _issuesDurationsCache: { [key: string]: WebToolIssueDuration } = {};

    private makeIssueDurationKey(identifier: WebToolIssueIdentifier) {
        return identifier.serviceUrl + '/' + identifier.issueUrl;
    }

    private getIssueDurationFromCache(identifier: WebToolIssueIdentifier): WebToolIssueDuration {
        return this._issuesDurationsCache[this.makeIssueDurationKey(identifier)];
    }

    private putIssuesDurationsToCache(durations: WebToolIssueDuration[]) {
        durations.forEach(duration => {
            this._issuesDurationsCache[this.makeIssueDurationKey(duration)] = duration;
        });
    }

    private removeIssuesDurationsFromCache(identifiers: WebToolIssueIdentifier[]) {
        identifiers.forEach(identifier => {
            delete this._issuesDurationsCache[this.makeIssueDurationKey(identifier)];
        });
    }

    private clearIssuesDurationsCache() {
        this._issuesDurationsCache = {};
    }

    private getIssuesDurations(identifiers: WebToolIssueIdentifier[]): Promise<WebToolIssueDuration[]> {

        const durations = <WebToolIssueDuration[]>[];
        const fetchIdentifiers = <WebToolIssueIdentifier[]>[];

        // Do not show durations of tasks without url
        identifiers = identifiers.filter(_ => !!_.serviceUrl && !!_.issueUrl);

        identifiers.forEach(identifier => {
            const duration = this.getIssueDurationFromCache(identifier);
            if (duration) {
                durations.push(duration);
            }
            else {
                fetchIdentifiers.push(identifier);
            }
        });

        if (durations.length == identifiers.length) {
            return Promise.resolve(durations);
        }

        return new Promise<WebToolIssueDuration[]>(resolve => {
            this._connection.fetchIssuesDurations(fetchIdentifiers)
                .then(fetchDurations => {
                    this.putIssuesDurationsToCache(fetchDurations);
                    resolve(durations.concat(fetchDurations));
                })
                .catch(() => {
                    resolve([]);
                });
        });
    }

    private async showLoginDialog() {

        if (this._loginWinId) {

            const tabs = await chrome.tabs.query({ windowId: this._loginWinId });
            const constants = await this._constants;

            const tab = tabs.find(tab => tab.id == this._loginTabId);
            if (tab?.url?.startsWith(constants.authorityUrl) && tab.id != null) {
                chrome.tabs.update(tab.id, { active: true });
                chrome.windows.update(this._loginWinId, { focused: true });
            } else {
                this._loginWinId = undefined;
                this._loginTabId = undefined;
                this.showLoginDialog();
            }

            return;
        }

        if (this._loginWindowPending) {
            return;
        }
        this._loginWindowPending = true;
        try {
            await this.createLoginDialog();
        }
        catch (e) {
            this._loginWindowPending = false;
        }
    }

    private setButtonIcon(icon: string, tooltip: string) {
        const action = chrome.action || chrome.browserAction;
        action.setIcon({
            path: {
                '19': 'images/' + icon + '19.png',
                '38': 'images/' + icon + '38.png'
            }
        });
        action.setTitle({ title: tooltip });
    }

    private async createLoginDialog() {

        const constants = await this._constants;
        const url = `${constants.authorityUrl}extension/login.html`;

        const tab = await chrome.tabs.create({ url } as chrome.tabs.CreateProperties);
        this._loginWinId = tab.windowId;
        this._loginTabId = tab.id!;
        this._loginWindowPending = false;
    }

    private getActiveTabUrl() {
        return new Promise<string | null>((resolve) => {
            chrome.tabs.query({ currentWindow: true, active: true },
                function (tabs) {
                    const activeTab = tabs && tabs[0];
                    const url = activeTab?.url || null;
                    resolve(url);
                });
        });
    }

    private registerInstallListener() {
        chrome.runtime.onInstalled.addListener(async details => {
            const neverLoggedIn = await this._connection.ajaxClient.neverLoggedIn();
            if (!neverLoggedIn) {
                chrome.storage.local.set({ 'skipPermissionsSetup': true });
            }
            if (details.reason == 'install' ||
                neverLoggedIn && details.reason == 'update') {
                this.showLoginDialog();
            }
        });
    }

    private registerStorageListener() {
        chrome.storage.onChanged.addListener(async (changes) => {
            const authorizationCode = changes['authorization_code'];
            if (authorizationCode && authorizationCode.newValue) {
                if (this._loginTabId != null) {
                    chrome.tabs.remove(this._loginTabId);
                }
                if (await this._connection.ajaxClient.authorize()) {
                    this.reconnect(false);
                }
            }
        });
    }

    private registerTabsRemoveListener() {
        chrome.tabs.onRemoved.addListener((tabId) => {
            if (tabId == this._loginTabId) {
                this._loginTabId = undefined;
                this._loginWinId = undefined;
            }
        });
    }

    private async onPermissionsMessage(message: ITabMessage, callback: (data: any) => void) {
        if (message.action == 'getIntegratedServices') {
            const items = await this.getIntegratedServices();
            callback(items);
        }
    }

    private async getIntegratedServices() {
        try {

            const integrations = (await this._connection.getIntegrations())
                .filter(item => !!WebToolManager.toServiceUrl(item.serviceUrl));
            const descriptions = getWebToolDescriptions()
                .reduce(
                    (map, description) => (map[description.serviceType] = description) && map,
                    <{ [serviceType: string]: WebToolDescription }>{});

            const serviceTypesMap = integrations.reduce((map, { serviceType, serviceUrl }) => {

                const description = descriptions[serviceType];
                if (description) {

                    // add known origins
                    description.origins.forEach(origin => map[origin] = serviceType);

                    // add additional origins
                    if (description.hasAdditionalOrigins) {
                        const serviceUrlNormalized = WebToolManager.toServiceUrl(serviceUrl);
                        const isServiceUrlMatchKnownOrigin = description.origins
                            .some(origin => WebToolManager.isMatch(serviceUrl, origin));
                        if (serviceUrlNormalized && !isServiceUrlMatchKnownOrigin) {
                            map[serviceUrlNormalized] = serviceType;
                        }
                    }
                }

                return map;
            }, <ServiceTypesMap>{});

            return serviceTypesMap;
        } catch (error) {
            console.log(error)
        }
    }

    private async openOptionsPageUrl() {
        const url = chrome.runtime.getURL('settings/settings.html');
        this.openPage(url);
    }

    private contentScriptRegistrator = new ContentScriptsRegistrator();

    private isConnectionRetryEnabledPopupAction() {
        return this._connection.isConnectionRetryEnabled();
    }

    private retryConnectionPopupAction() {
        return this._connection.retryConnection();
    }
}