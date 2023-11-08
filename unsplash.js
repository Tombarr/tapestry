(function() {
  let PUBLISHER_ID = 'ed847862-2f6a-441e-855e-7e405549cf48'; // KaiAds
  let NAME = 'Unsplash'; // Sort
  const ONE_DAY = 60 * 60 * 24; // One Day
  const DEFAULT_EXTENSION = '.jpg';
  let TASK_NAME = 'unsplash';
  let TEST = 0; // Test

  if (TEST === 0) {
    console.log = function () {};
    console.info = function () {};
    console.debug = function () {};
    console.warn = function () {};
}

  // From https://developer.mozilla.org/en-US/docs/Web/API/Element/toggleAttribute
  if (!Element.prototype.toggleAttribute) {
    Element.prototype.toggleAttribute = function(name, force) {
      if(force !== void 0) force = !!force
  
      if (this.hasAttribute(name)) {
        if (force) return true;
  
        this.removeAttribute(name);
        return false;
      }
      if (force === false) return false;
  
      this.setAttribute(name, "");
      return true;
    };
  }

  // @return [Headers]
  function toHeaders(headerStr) {
    const headerEntries = headerStr.split('\r\n')
      .map((h) => {
        const firstSemi = h.indexOf(':');
        return [h.substring(0, firstSemi).trim(), h.substring(firstSemi + 1).trim()];
      })
      .filter((h) => h && h[0] && h[0].length > 0 && h[1] && h[1].length > 0);
  
    const headers = new Headers();
    headerEntries.forEach(([key, value]) => {
      try {
        headers.append(key, value);
      } catch (e) {
        // TypeError "is an invalid header value" for Set-Cookie
        if (e && !e.message.indexOf('is an invalid header value')) {
          onError(e);
        }
      }
    });
  
    return headers;
  }

  // @return [Response]
  function toResponse(xhr) {
    // Assumes responseType = 'blob'
    return new Response(xhr.response, {
      status: xhr.status,
      statusText: xhr.statusText,
      headers: toHeaders(xhr.getAllResponseHeaders()),
    });
  }

  // @return [Promise<Response>] Make Fetch-like request without CORS
  function xhrFetch(url) {
    return new Promise((resolve, reject) => {
      let xhr = new XMLHttpRequest({ mozSystem: true, mozAnon: true, mozBackgroundRequest: true });
      xhr.responseType = 'blob';
      xhr.open('GET', url, true);
      xhr.setRequestHeader('Accept', '*/*');
      xhr.addEventListener('error', (e) =>
        reject(new Error('Network Error #' + e.target.status)));
      xhr.addEventListener('loadend', (e) => resolve(toResponse(e.target)));
      xhr.send();
    });
  }

  let snackbarTimeout = 0;
  let dimTimeout = 0;
  let hasSyncMessage = false;
  let minAdWaitDuration = 1000 * 60; // 1 min
  let lastAdAttempt = Date.now() - (1000 * 45); // 15 sec grace period

  // Show a toast message
  function showToastMessage(messageStr) {
    let snackbar = document.getElementById("snackbar");
    snackbar.innerText = messageStr;
    snackbar.classList.add('show');
    clearTimeout(snackbarTimeout);
    snackbarTimeout = setTimeout(function() {
      snackbar.classList.remove('show');
    }, 3000);
  }

  // Dim/undim the UI
  function updateDimming() {
    /*document.body.classList.remove('dim');
    clearTimeout(dimTimeout);
    dimTimeout = setTimeout(function() {
      document.body.classList.add('dim');
    }, 5000);*/
  }

  function toFullWidth(urlStr) {
    if (!urlStr) return urlStr;
    let url = new URL(urlStr);
    url.searchParams.set('w', '240');
    url.searchParams.set('q', '90');
    return url.toString();
  }

  function getUnsplashCollections(per_page = 20, page = 0) {
    return xhrFetch('https://unsplash.com/napi/collections?per_page=' + per_page + '&page=' + page)
      .then((resp) => resp.json())
      .then((resp) => {
        console.log(resp);
        return resp;
      })
      .then((collectionResponse) => collectionResponse.map((item) => ({
        id: item.id,
        title: item.title,
        description: item.cover_photo.alt_description,
        count: item.total_photos,
        thumbnail: toFullWidth(item.cover_photo.urls.thumb),
        preview: item.preview_photos.map((prev) => ({
          id: prev.id,
          thumbnail: toFullWidth(prev.urls.thumb),
        })),
      })))
  }

  let hasMessageHandler = (typeof navigator === 'object' && 'mozSetMessageHandler' in navigator);

  // @returns [Promise] Register ServiceWorker
  function registerServiceWorker() {
    return navigator.serviceWorker
      .register('./sw.js', { scope: '/' })
      .then((registration) => {
        console.debug('ServiceWorker Registered!');

        if (!navigator.serviceWorker.controller) {
          // The window client isn't currently controlled so it's a new service
          // worker that will activate immediately
          return Promise.resolve(true);
        }

        // Start handling messages immediately
        if ('startMessages' in navigator.serviceWorker) {
          navigator.serviceWorker.startMessages();
        }

        // Update the SW, if available
        if ('update' in registration && navigator.onLine) {
          return registration.update();
        }

        return Promise.resolve(true);
      });
  }

  // @returns [ServiceWorkerRegistration] ServiceWorkerRegistration
  function getRegistration() {
    if (typeof self === 'object' && self.registration) {
      return Promise.resolve(self.registration);
    }

    if (typeof navigator === 'object' && navigator.serviceWorker) {
      return navigator.serviceWorker.ready;
    }

    return Promise.resolve(undefined);
  }

  // @returns [Boolean|Promise]
  function setMessageHandler(name, handler) {
    if (hasMessageHandler) {
      // KaiOS 2.5
      return Promise.resolve(navigator.mozSetMessageHandler(name, handler) || true);
    } else if ('systemMessageManager' in ServiceWorkerRegistration.prototype) {
      // KaiOS 3.0
      return getRegistration()
        .then((registration) => {
          if (registration && registration.systemMessageManager) {
            return registration.systemMessageManager.subscribe(name);
          }
        })
        .catch((e) => console.warn(`Cannot subscribe to ${name} system messages.`, e));
    }

    return false;
  }

  let unsplashCollections = [];
  let unsplashIndex = 0;
  let wallpaperLoaded = false;
  let dialogOpen = false;

  let wallpaper = document.getElementById('wallpaper');
  let title = document.getElementById('title');
  let copyright = document.getElementById('copyright');
  let softkeyMenu = document.getElementById('softkey-menu');
  let controls = document.getElementById('controls');
  let menuDialog = document.getElementById('menu-list');
  let noInternetDialog = document.getElementById('no-internet');
  let dailyButton = document.getElementById('button-toggle-daily');
  let loadingIndicator = document.getElementById('loading-indicator');

  // Update text for daily sync
  function updateDailyButton(syncEnabled) {
    dailyButton.innerText = (syncEnabled) ? '3. Disable Daily' : '3. Enable Daily';
  }

  // @returns [Boolean] True if the index has changed
  function updateUnsplashIndex(n) {
    let originalIndex = unsplashIndex;
    unsplashIndex += n;

    if (unsplashIndex < 0) {
      unsplashIndex = 0;
    } else if (unsplashIndex === unsplashCollections.length) {
      unsplashIndex = unsplashCollections.length - 1;
    }

    console.log('updateUnsplashIndex', n, originalIndex, unsplashIndex, unsplashCollections.length);
    return (originalIndex !== unsplashIndex);
  }

  function hasDescription(imageObj) {
    return (imageObj && imageObj.description && imageObj.description.length);
  }

  // Update SoftKey offset
  function updateSoftKeyPosition() {
    let rect = copyright.getBoundingClientRect();
    let imageObj = unsplashCollections[unsplashIndex];
    if (rect.top && hasDescription(imageObj)) {
      softkeyMenu.style.top = Math.round(rect.top - 30) + 'px';
    } else {
      softkeyMenu.style.top = '';
    }
  }

  // Display the Unsplash image based on the current index
  function displayUnsplashImage() {
    let imageObj = unsplashCollections[unsplashIndex];

    if (imageObj) {
      title.innerText = imageObj.title;
      copyright.innerText = imageObj.description;
      copyright.classList.toggle('empty', !hasDescription(imageObj));
      requestAnimationFrame(updateSoftKeyPosition);

      wallpaperLoaded = false;
      loadingIndicator.classList.toggle('loading', true);
      requestAnimationFrame(maybeLoadAd);
      return setImagePromise(imageObj.thumbnail)
        .then(() => {
          wallpaperLoaded = true;
          loadingIndicator.classList.toggle('loading', false);
        })
        .catch(() => {
          wallpaperLoaded = false;
          loadingIndicator.classList.toggle('loading', false);
          showToastMessage('Error Loading Wallpaper');
        });
    }

    return Promise.reject(null);
  }

  // Display the Unsplash gallery
  function displayUnsplashGallery(collections) {
    unsplashCollections = collections;
    return displayUnsplashImage();
  }

  function toggleDialogVisibility() {
    menuDialog.toggleAttribute('open');
    menuDialog.toggleAttribute('hidden');
    dialogOpen = menuDialog.hasAttribute('open');
  }

  // Toggle arrow visibility
  function toggleArrowVisibility() {
    if (unsplashIndex === 0) {
      controls.classList.add('start');
    } else if (unsplashIndex === unsplashCollections.length - 1) {
      controls.classList.add('end');
    } else {
      controls.classList.remove('start');
      controls.classList.remove('end');
    }
  }

  // Next wallpaper
  function prevWallpaper() {
    if (updateUnsplashIndex(-1)) {
      displayUnsplashImage()
        .then(() => toggleArrowVisibility());
    }
  }

  // Previous wallpaper
  function nextWallpaper() {
    if (updateUnsplashIndex(1)) {
      displayUnsplashImage()
        .then(() => toggleArrowVisibility());
    }
  }

  function getRandomWallpaperFromCollectionURL(collectionId) {
    console.log('getRandomWallpaperFromCollectionURL', collectionId);
    let collection_id = collectionId || unsplashCollections[unsplashIndex].id;
    let digits = Math.floor(Math.random() * 9000000000) + 1000000000;
    return 'https://source.unsplash.com/collection/' + collection_id + '/240x320?sig=' + digits;
  }

  // Get random wallpaper in collection
  function getRandomWallpaperFromCollection(collectionId) {
    console.log('getRandomWallpaperFromCollection', collectionId);
    let randomImageUrl = getRandomWallpaperFromCollectionURL(collectionId);
    if (unsplashCollections && unsplashCollections.length) {
      unsplashCollections[unsplashIndex].thumbnail = randomImageUrl;
      unsplashCollections[unsplashIndex].description = '';
    }
    return displayUnsplashImage()
      .then(() => toggleArrowVisibility());
  }

  function onError(error) {
    console.trace();
    console.error(error.name, error.message);
    console.error(error);
  }

  // @returns [Promise] Show notification via ServiceWorker
  function showNotification(title, body, icon, tag, data) {
    console.debug('showNotification', title, body);
    return getRegistration()
      .then((registration) => registration.showNotification(title, {
        actions: [{
          action: 'open',
          title: 'Open',
        }, {
          action: 'dismiss',
          title: 'Dismiss',
        }],
        body,
        icon: icon,
        tag: tag || title.replace(/\s/ug, '').toLowerCase(),
        data: data || { },
        silent: true,
        requireInteraction: false,
        renotify: false,
        noscreen: true,
        mozbehavior: {
          showOnlyOnce: true,
        },
      }));
  }

  function showSuccessNotification() {
    console.debug('showErrorNotification');
    return showNotification('Wallpaper Updated', 'Wallpaper successfully updated!');
  }

  function showOfflineNotification() {
    console.debug('showOfflineNotification');
    return showNotification('No Internet', 'Cannot set wallpaper');
  }

  function showErrorNotification() {
    console.debug('showErrorNotification');
    return showNotification('Error', 'Cannot set wallpaper');
  }

  // @returns [Promise] Set the wallpaper and resolve when loaded
  function setImagePromise(srcUrl) {
    return new Promise((resolve, reject) => {
      wallpaper.addEventListener('load', resolve);
      wallpaper.addEventListener('error', reject);
      wallpaper.src = srcUrl;
    });
  }

  function exit() {
    console.debug('exit');
    return Promise.resolve(setTimeout(() => window.close()));
  }

  // @return [Promise] Set wallpaper to latest from Unsplash
  function setLatestWallpaperAsync(collectionId) {
    // Use the Collection ID stored as data for the RequestSync Task
    let imageUrl = getRandomWallpaperFromCollectionURL(collectionId);

    // Download image and set it was the new wallpaper
    return xhrFetch(imageUrl)
      .then((resp) => resp.blob()) // Download wallpaper
      .then(setWallpaperFromBlob) // Set wallpaper
      .then(showSuccessNotification)
      .then(exit) // Close app
      .catch((e) => {
        onError(e);
        return showErrorNotification();
      });
  }

  // Handler on Mozilla RequestSync API
  function onMozSync(syncObject) {
    hasSyncMessage = true;
    console.debug('onMozSync', syncObject, navigator.onLine);

    if (navigator.onLine) {
      navigator.mozSetMessageHandlerPromise(
        Promise.all([
          setLatestWallpaperAsync(syncObject.data)
        ])
      );
    } else {
      navigator.mozSetMessageHandlerPromise(
        showOfflineNotification()
      );
    }
  }

  // @returns [Promise<Blob>] Get current wallpaper as a blob
  function getWallpaperBlob() {
    console.debug('getWallpaperBlob');
    return new Promise((resolve, reject) => {
      try {
        let canvas = document.createElement('canvas');
        canvas.width = document.body.clientWidth * window.devicePixelRatio;
        canvas.height = document.body.clientHeight * window.devicePixelRatio;
        let context = canvas.getContext("2d");
        context.drawImage(wallpaper, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(resolve, "image/jpeg");
      } catch (e) {
        onError(e);
        reject(e);
      }
    });
  }

  // @return Promise<Boolean> Set wallpaper from Blob
  function setWallpaperFromBlob(blob) {
    console.debug('setWallpaperFromBlob', blob);

    return new Promise((resolve, reject) => {
      let domRequest = navigator.mozSettings.createLock().set({
        "wallpaper.image": blob,
      });

      domRequest.onsuccess = () => {
        console.debug('Wallpaper Set');
        showToastMessage('Wallpaper Set');
        resolve(true);
      };

      domRequest.onerror = (e) => {
        console.debug('Cannot Set Wallpaper', e);
        onError(e);
        showToastMessage('Cannot Set Wallpaper');
        reject(e);
      };
    });
  }

  // Set the system wallpaper to the current image preview
  function setWallpaperFromPreview() {
    console.debug('setWallpaperFromPreview');
    return getWallpaperBlob()
      .then(setWallpaperFromBlob);
  }

  // @returns [String] Get random file name
  function getRandomFileName() {
    let digits = Math.floor(Math.random() * 9000000000) + 1000000000;
    return digits.toString() + DEFAULT_EXTENSION;
  }

  // @returns [String] Get file name for the current wallpaper
  function getFileName() {
    try {
      const url = new URL(wallpaper.src);
      if (url.searchParams.has('sig')) {
        return url.searchParams.get('sig') + DEFAULT_EXTENSION;
      } else {
        // File names cannot start with leading slash
        return url.pathname.substring(1) + DEFAULT_EXTENSION;
      }
    } catch (e) {
      onError(e);
    }
  }

  // @returns [Promise] Turn DOMRequest into a Promise
  function toPromise(domRequest) {
    return new Promise((resolve, reject) => {
      domRequest.onsuccess = (e) => resolve(e.target.result);
      domRequest.onerror = (e) => reject(e.target.error);
    });
  }

  let hasDeviceStorage = (
    typeof navigator !== 'undefined' &&
    'getDeviceStorage' in navigator
  );

  class StorageUnavailableError extends Error {
    constructor(message) {
      super(message);
      this.name = "StorageUnavailableError";
    }
  }

  // Download wallpaper to disk
  function downloadWallpaper() {
    if (!hasDeviceStorage) {
      return showToastMessage('Storage unavailable');
    }

    const fileName = getFileName() || getRandomFileName();
    const pictures = navigator.getDeviceStorage('pictures');

    // Check disk space
    if (pictures.lowDiskSpace) {
      return showToastMessage('Low disk space');
    }

    return toPromise(pictures.available())
      .then((result) => {
        if (result === 'available') {
          return getWallpaperBlob();
        } else {
          throw new StorageUnavailableError('Storage state: ' + result);
        }
      })
      .then((blob) => toPromise(pictures.addNamed(blob, fileName)))
      .then(() => showToastMessage('Saved to Gallery'))
      .catch((e) => {
        if (e.name === 'NoModificationAllowedError') {
          return showToastMessage('Already saved')
        } else if (e.name === 'StorageUnavailableError') {
          return showToastMessage('Storage unavailable');
        } else {
          onError(e);
          return showToastMessage('Error downloading');
        }
      });
  }

  // Toggle detailed information
  function toggleInfo() {
    document.body.classList.toggle('show-info');
    requestAnimationFrame(updateSoftKeyPosition);
  }

  // KaiOS 2.5
  let hasMozSyncApi = (
    typeof navigator !== 'undefined' &&
    'sync' in navigator
  );

    function hasRegisteredSyncTask(taskName) {
      console.log('hasRegisteredSyncTask', taskName, hasMozSyncApi);
      if (!hasMozSyncApi) return Promise.resolve(false);

      return navigator.sync.registrations()
        .then(function(registrations) {
          return registrations.some(function(reg) {
              return (reg.task === taskName);
          });
        });
    }

  function register(taskName, minInterval, data) {
    if (!hasMozSyncApi) return Promise.resolve(false);

    return navigator.sync.registrations()
      .then(function(registrations) {
          let existingReg;
          registrations.some(function(reg) {
              if (reg.task === taskName) {
                  return !!(existingReg = reg);
              }
          });

          if (existingReg) {
              return false;
          }

          return navigator.sync.register(taskName, {
              minInterval: minInterval, // seconds
              oneShot: false,
              wifiOnly: false,
              wakeUpPage: location.href,
              data: data,
          });
      });
  }

  function unregister(taskName) {
      if (!hasMozSyncApi) return Promise.resolve(false);

      return navigator.sync.unregister(taskName);
  }

  // @returns [Promise] Register ServiceWorker
  function registerServiceWorker() {
    return navigator.serviceWorker
      .register('./sw.js', {
          scope: '/'
      })
      .then((registration) => {
          if (!navigator.serviceWorker.controller) {
              // The window client isn't currently controlled so it's a new service
              // worker that will activate immediately
              return Promise.resolve(true);
          }

          // Start handling messages immediately
          if ('startMessages' in navigator.serviceWorker) {
              navigator.serviceWorker.startMessages();
          }

          // Update the SW, if available
          if ('update' in registration && navigator.onLine) {
              return registration.update();
          }

          return Promise.resolve(true);
      });
  }

  // Attempt to load a KaiAd, with a wait duration
  function maybeLoadAd() {
    let now = Date.now();
    console.log('maybeLoadAd', now - lastAdAttempt);

    // Wait at least 1 minute before trying
    if (now - lastAdAttempt < minAdWaitDuration) {
      return Promise.resolve(false);
    }

    lastAdAttempt = now;
    return loadKaiAd()
      .then((ad) => (ad) ? ad.call('display') : ad)
      .catch(onError);
  }

  // Disply a KaiAd
  function loadKaiAd() {
    if (typeof getKaiAd !== 'function') return Promise.resolve(false);

    return new Promise((resolve, reject) => {
      return getKaiAd({
        publisher: PUBLISHER_ID,
        app: NAME,
        slot: 'main',
        test: TEST,
        onerror: (err) => reject(err),
        onready: (ad) => resolve(ad),
      });
    });
  }

  // Toggle (enable/ disable) the daily RequestSync Task
  function toggleDaily() {
    console.log('toggleDaily');
    return hasRegisteredSyncTask(TASK_NAME)
      .then((registered) => {
        if (registered) {
          console.log('toggleDaily', registered);
          // Unregister the RequestSync  Task
          return unregister(TASK_NAME)
            .then(() => hasRegisteredSyncTask(TASK_NAME));
        } else {
          // Register the RequestSync Task
          return register(TASK_NAME, ONE_DAY, unsplashCollections[unsplashIndex].id)
            .then(() => hasRegisteredSyncTask(TASK_NAME));
        }
      })
      .then((registered) => {
        updateDailyButton(registered);
        showToastMessage((registered) ? 'Daily wallpaper enabled' : 'Daily wallpaper disabled');
      })
      .catch(onError);
  }

  wallpaper.addEventListener('error', function onImageError(e) {
    requestAnimationFrame(updateDimming);
    onError(e);
    showToastMessage('Cannot Load Image');
  });

  window.addEventListener('keydown', function onKeyDown(e) {
    console.debug('keydown', e.key, e);
    requestAnimationFrame(updateDimming);

    switch (e.key) {
      case 'ArrowLeft':
        if (!dialogOpen) {
          prevWallpaper();
        }
        break;
      case 'ArrowRight':
        if (!dialogOpen) {
          nextWallpaper();
        }
        break;
      case 'SoftLeft':
        if (!dialogOpen) {
          toggleInfo();
        }
        break;
      case 'SoftRight':
        if (wallpaperLoaded) {
          toggleDialogVisibility();
        }
        break;
      case "1":
        if (dialogOpen) {
          setWallpaperFromPreview();
          requestAnimationFrame(toggleDialogVisibility);
        }
        break;
      case "2":
        if (dialogOpen) {
          downloadWallpaper();
          requestAnimationFrame(toggleDialogVisibility);
        }
        break;
      case "3":
        if (dialogOpen) {
          toggleDaily();
          requestAnimationFrame(toggleDialogVisibility);
        }
        break;
      case "4":
        if (dialogOpen) {
          getRandomWallpaperFromCollection();
          requestAnimationFrame(toggleDialogVisibility);
        }
        break;
      case 'Backspace':
      case 'Delete':
      case 'GoBack':
        if (dialogOpen) {
          requestAnimationFrame(toggleDialogVisibility);
        } else {
          exit();
        }
        break;
      case 'ArrowDown':
      case 'Enter':
        requestAnimationFrame(() => getRandomWallpaperFromCollection());
        break;
    }
  });

  if (!navigator.onLine) {
    // Warn No Internet
    noInternetDialog.toggleAttribute('hidden');
    noInternetDialog.toggleAttribute('open');
    document.body.classList.add('no-internet');
  } else {
    hasSyncMessage = navigator.mozHasPendingMessage('request-sync');
    console.debug('Unsplash', 'launched', hasSyncMessage);

    setMessageHandler('request-sync', onMozSync);

    // Update UI outside of sync request
    if (!hasSyncMessage) {
      // Check if sync set
      hasRegisteredSyncTask(TASK_NAME)
        .then((hasTask) => updateDailyButton(hasTask));

      // Load Unsplash collections
      registerServiceWorker()
        .then(() => getUnsplashCollections(20))
        .then(displayUnsplashGallery)
        .catch(onError);
    }
  }
})();