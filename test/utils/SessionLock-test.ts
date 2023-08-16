/*
Copyright 2023 The Matrix.org Foundation C.I.C.

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

import { getSessionLock } from "../../src/utils/SessionLock";

describe("SessionLock", () => {
    const otherWindows: Array<Window> = [];
    let windowEventListeners: Array<[string, any]>;
    let documentEventListeners: Array<[string, any]>;

    beforeEach(() => {
        jest.useFakeTimers({ now: 1000 });

        // keep track of the registered event listeners, so that we can unregister them in `afterEach`
        windowEventListeners = [];
        const realWindowAddEventListener = window.addEventListener.bind(window);
        jest.spyOn(window, "addEventListener").mockImplementation((type, listener, options) => {
            const res = realWindowAddEventListener(type, listener, options);
            windowEventListeners.push([type, listener]);
            return res;
        });

        documentEventListeners = [];
        const realDocumentAddEventListener = document.addEventListener.bind(document);
        jest.spyOn(document, "addEventListener").mockImplementation((type, listener, options) => {
            const res = realDocumentAddEventListener(type, listener, options);
            documentEventListeners.push([type, listener]);
            return res;
        });
    });

    afterEach(() => {
        // shut down other windows created by `createWindow`
        otherWindows.forEach((window) => window.close());
        otherWindows.splice(0);

        // remove listeners on our own window
        windowEventListeners.forEach(([type, listener]) => window.removeEventListener(type, listener));
        documentEventListeners.forEach(([type, listener]) => document.removeEventListener(type, listener));

        localStorage.clear();
        jest.restoreAllMocks();
    });

    it("A single instance starts up normally", async () => {
        const onNewInstance = jest.fn();
        const result = await getSessionLock(onNewInstance);
        expect(result).toBe(true);
        expect(onNewInstance).not.toHaveBeenCalled();
    });

    it("A second instance starts up normally when the first shut down cleanly", async () => {
        // first instance starts...
        const onNewInstance1 = jest.fn();
        expect(await getSessionLock(onNewInstance1)).toBe(true);
        expect(onNewInstance1).not.toHaveBeenCalled();

        // ... and navigates away
        window.dispatchEvent(new Event("pagehide", {}));

        // second instance starts as normal
        const onNewInstance2 = jest.fn();
        expect(await getSessionLock(onNewInstance2)).toBe(true);

        expect(onNewInstance1).not.toHaveBeenCalled();
        expect(onNewInstance2).not.toHaveBeenCalled();
    });

    it("A second instance starts up *eventually* when the first terminated uncleanly", async () => {
        // first instance starts...
        const onNewInstance1 = jest.fn();
        expect(await getSessionLock(onNewInstance1)).toBe(true);
        expect(onNewInstance1).not.toHaveBeenCalled();

        // and pings the timer after 5 seconds
        jest.advanceTimersByTime(5000);

        // oops, now it dies. We simulate this by forcibly clearing the timers.
        // For some reason `jest.clearAllTimers` also resets the simulated time, so preserve that
        const time = Date.now();
        jest.clearAllTimers();
        jest.setSystemTime(time);

        // time advances a bit more
        jest.advanceTimersByTime(5000);

        // second instance tries to start. This should block for 25 more seconds
        const onNewInstance2 = jest.fn();
        let session2Result: boolean | undefined;
        getSessionLock(onNewInstance2).then((res) => {
            session2Result = res;
        });

        // after another 24.5 seconds, we are still waiting
        jest.advanceTimersByTime(24500);
        expect(session2Result).toBe(undefined);

        // another 500ms and we get the lock
        await jest.advanceTimersByTimeAsync(500);
        expect(session2Result).toBe(true);

        expect(onNewInstance1).not.toHaveBeenCalled();
        expect(onNewInstance2).not.toHaveBeenCalled();
    });

    it("A second instance waits for the first to shut down", async () => {
        // first instance starts. Once it gets the shutdown signal, it will wait two seconds and then release the lock.
        await getSessionLock(
            () =>
                new Promise<void>((resolve) => {
                    setTimeout(resolve, 2000, 0);
                }),
        );

        // second instance tries to start, but should block
        const { window: window2, getSessionLock: getSessionLock2 } = buildNewContext();
        let session2Result: boolean | undefined;
        getSessionLock2(async () => {}).then((res) => {
            session2Result = res;
        });
        await jest.advanceTimersByTimeAsync(100);
        // should still be blocking
        expect(session2Result).toBe(undefined);

        await jest.advanceTimersByTimeAsync(2000);
        await jest.advanceTimersByTimeAsync(0);

        // session 2 now gets the lock
        expect(session2Result).toBe(true);
        window2.close();
    });

    it("If two new instances start concurrently, only one wins", async () => {
        // first instance starts. Once it gets the shutdown signal, it will wait two seconds and then release the lock.
        await getSessionLock(async () => {
            await new Promise<void>((resolve) => {
                setTimeout(resolve, 2000, 0);
            });
        });

        // first instance should ping the timer after 5 seconds
        jest.advanceTimersByTime(5000);

        // two new instances start at once
        const { getSessionLock: getSessionLock2 } = buildNewContext();
        let session2Result: boolean | undefined;
        getSessionLock2(async () => {}).then((res) => {
            session2Result = res;
        });

        const { getSessionLock: getSessionLock3 } = buildNewContext();
        let session3Result: boolean | undefined;
        getSessionLock3(async () => {}).then((res) => {
            session3Result = res;
        });

        await jest.advanceTimersByTimeAsync(100);
        // session 3 still be blocking. Session 2 should have given up.
        expect(session2Result).toBe(false);
        expect(session3Result).toBe(undefined);

        await jest.advanceTimersByTimeAsync(2000);
        await jest.advanceTimersByTimeAsync(0);

        // session 3 now gets the lock
        expect(session2Result).toBe(false);
        expect(session3Result).toBe(true);
    });

    /** build a new Window in the same domain as the current one.
     *
     * We do this by constructing an iframe, which gets its own Window object.
     */
    function createWindow() {
        const iframe = window.document.createElement("iframe");
        window.document.body.appendChild(iframe);
        const window2: any = iframe.contentWindow;

        otherWindows.push(window2);

        // make the new Window use the same jest fake timers as us
        for (const m of ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"]) {
            // @ts-ignore
            window2[m] = global[m];
        }
        return window2;
    }

    /**
     * Instantiate `getSessionLock` in a new context (ie, using a different global `window`).
     *
     * The new window will share the same fake timer impl as the current context.
     *
     * @returns the new window and (a wrapper for) getSessionLock in the new context.
     */
    function buildNewContext(): {
        window: Window;
        getSessionLock: (onNewInstance: () => Promise<void>) => Promise<boolean>;
    } {
        const window2 = createWindow();

        // import the dependencies of getSessionLock into the new context
        window2._uuid = require("uuid");
        window2._logger = require("matrix-js-sdk/src/logger");

        // now, define getSessionLock as a global
        window2.eval(String(getSessionLock));

        // return a function that will call it
        function callGetSessionLock(onNewInstance: () => Promise<void>): Promise<boolean> {
            // import the callback into the context
            window2._getSessionLockCallback = onNewInstance;

            // start the function
            try {
                return window2.eval(`getSessionLock(_getSessionLockCallback)`);
            } finally {
                // we can now clear the callback
                delete window2._getSessionLockCallback;
            }
        }

        return { window: window2, getSessionLock: callGetSessionLock };
    }
});
