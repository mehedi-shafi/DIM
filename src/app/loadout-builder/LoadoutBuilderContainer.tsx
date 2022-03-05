import { defaultLoadoutParameters, LoadoutParameters } from '@destinyitemmanager/dim-api-types';
import ShowPageLoading from 'app/dim-ui/ShowPageLoading';
import { t } from 'app/i18next-t';
import { allItemsSelector } from 'app/inventory/selectors';
import { useLoadStores } from 'app/inventory/store/hooks';
import { SocketOverrides } from 'app/inventory/store/override-sockets';
import { Loadout } from 'app/loadout-drawer/loadout-types';
import { newLoadout } from 'app/loadout-drawer/loadout-utils';
import { parseLoadoutFromURLParam } from 'app/loadout-drawer/LoadoutDrawer2';
import { useD2Definitions } from 'app/manifest/selectors';
import { showNotification } from 'app/notifications/notifications';
import { setSearchQuery } from 'app/shell/actions';
import ErrorPanel from 'app/shell/ErrorPanel';
import { useThunkDispatch } from 'app/store/thunk-dispatch';
import { DestinyClass } from 'bungie-api-ts/destiny2';
import produce from 'immer';
import React, { useEffect } from 'react';
import { useSelector } from 'react-redux';
import { useLocation, useNavigate } from 'react-router';
import { createSelector } from 'reselect';
import { DestinyAccount } from '../accounts/destiny-account';
import { savedLoadoutParametersSelector } from '../dim-api/selectors';
import LoadoutBuilder from './LoadoutBuilder';

const disabledDueToMaintenanceSelector = createSelector(
  allItemsSelector,
  (items) => items.length > 0 && items.every((item) => item.missingSockets)
);

/**
 * The Loadout Optimizer provides an interface for editing the armor of a loadout to pick optimal armor sets with mods included.
 *
 * This container makes sure stores are loaded, and either parses or creates the initial loadout the LO will be working with.
 */
export default function LoadoutBuilderContainer({ account }: { account: DestinyAccount }) {
  const storesLoaded = useLoadStores(account);
  const disabledDueToMaintenance = useSelector(disabledDueToMaintenanceSelector);

  // Get a starting loadout for the LO based on URL params and such
  const initialLoadout = useInitialLoadout();
  const query = initialLoadout?.parameters?.query ?? '';
  useSyncSearchQuery(query);

  if (!storesLoaded) {
    return <ShowPageLoading message={t('Loading.Profile')} />;
  }

  // Don't even bother showing the tool when Bungie has shut off sockets.
  if (disabledDueToMaintenance) {
    return (
      <div className="dim-page">
        <ErrorPanel title={t('LoadoutBuilder.DisabledDueToMaintenance')} showTwitters />
      </div>
    );
  }

  // TODO: key off the URL params? Loadout ID?
  return (
    <LoadoutBuilder key={initialLoadout.id} account={account} initialLoadout={preloadedLoadout} />
  );
}

/**
 * Set the global search query to the provided string unless it's empty.
 */
function useSyncSearchQuery(query: string) {
  const dispatch = useThunkDispatch();
  useEffect(() => {
    if (query) {
      dispatch(setSearchQuery(query));
    }
  }, [dispatch, query]);
}

/**
 * Build the loadout that will be loaded into the Optimizer, which determines
 * the configured options and what loadout will be saved (by default). This is
 * either:
 *   - a whole loadout that has been passed in via URL parameters
 *   - a whole loadout passed from another part of the application from
 *     navigation state
 *   - a new loadout cobbled together from individual URL parameters (i.e. "old"
 *     LO links)
 *   - a brand new loadout preconfigured from saved defaults
 */
// TODO: this only works on initial navigation to this page - subsequent
// navigation within the same page won't recreate the component. Look into
// either using the loadout JSON as a key or some stable hash of it (or just
// detecting navigation and incrementing a number...)
function useInitialLoadout(): Loadout {
  // TODO: recreate the default loadout based on selected class type? Feels like this component should control that.
  // TODO: what does it look like when the user chooses a different loadout to compare against?
  const defs = useD2Definitions();
  const navigate = useNavigate();
  const { pathname, state, search } = useLocation();
  const savedLoadoutParameters = useSelector(savedLoadoutParametersSelector);

  // Try getting the loadout from state (if it was linked from elsewhere, like the loadout drawer)
  const preloadedLoadout = (state as { loadout: Loadout } | undefined)?.loadout;
  if (preloadedLoadout) {
    return preloadedLoadout;
  }

  // Look for a fully specified loadout in a query parameter
  const searchParams = new URLSearchParams(search);
  // This parameter isn't named "loadout" because sending that will load the loadout into the loadout drawer!
  const loadoutJSON = searchParams.get('l');
  if (loadoutJSON) {
    try {
      const parsedLoadout = parseLoadoutFromURLParam(loadoutJSON);
      if (parsedLoadout) {
        return parsedLoadout;
      }
    } catch (e) {
      showNotification({
        type: 'error',
        title: t('Loadouts.BadLoadoutShare'),
        body: t('Loadouts.BadLoadoutShareBody', { error: e.message }),
      });
    }
    // Clear the loadout from the URL params
    navigate(pathname, { replace: true });
  }

  // Create a new loadout based on URL parameters that specify parts of the loadout, or defaults
  const urlClassTypeString = searchParams.get('class');
  const urlLoadoutParametersJSON = searchParams.get('p');
  const subclassJSON = searchParams.get('s');
  const urlNotes = searchParams.get('n');
  let classType = urlClassTypeString ? parseInt(urlClassTypeString) : DestinyClass.Unknown;

  // Extract subclass info
  let subclass: { hash: number; socketOverrides: SocketOverrides } | undefined;
  if (subclassJSON) {
    try {
      subclass = JSON.parse(subclassJSON);
    } catch (e) {
      showNotification({
        type: 'error',
        title: t('Loadouts.BadLoadoutShare'),
        body: t('Loadouts.BadLoadoutShareBody', { error: e.message }),
      });
    }
  }

  // Default to saved loadout parameters, but allow URL to override them
  let loadoutParameters: LoadoutParameters | undefined = savedLoadoutParameters;
  if (urlLoadoutParametersJSON) {
    try {
      loadoutParameters = JSON.parse(urlLoadoutParametersJSON) as LoadoutParameters;
      // Strip out some parts of shared loadout parameters we don't want
      loadoutParameters = sanitizeLoadoutParameters({
        ...defaultLoadoutParameters,
        ...loadoutParameters,
      });
    } catch (e) {
      showNotification({
        type: 'error',
        title: t('Loadouts.BadLoadoutShare'),
        body: t('Loadouts.BadLoadoutShareBody', { error: e.message }),
      });
    }
  }

  // If the URL params specified an exotic without a class, set the class from the exotic
  if (
    defs &&
    classType === DestinyClass.Unknown &&
    loadoutParameters &&
    loadoutParameters.exoticArmorHash &&
    loadoutParameters.exoticArmorHash > 0
  ) {
    classType =
      defs.InventoryItem.get(loadoutParameters.exoticArmorHash)?.classType ?? DestinyClass.Unknown;
  }
  const constructedLoadout = newLoadout('', [], classType);
  constructedLoadout.parameters = loadoutParameters;
  constructedLoadout.notes = urlNotes || undefined;
  if (subclass) {
    constructedLoadout.items.push({
      ...subclass,
      id: Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(),
      amount: 1,
      equip: true,
    });
  }

  return constructedLoadout;
}

/**
 * Strip stuff out of saved or shared loadout parameters that we don't actually want to use?
 */
function sanitizeLoadoutParameters(loadoutParameters: LoadoutParameters) {
  return produce(loadoutParameters, (draft) => {
    if (draft.query && draft.query.length > 2048) {
      draft.query = '';
    }

    // Remove stat min/max, leave the order?
    if (draft.statConstraints) {
      for (const constraint of draft.statConstraints) {
        delete constraint.maxTier;
        delete constraint.minTier;
      }
    }

    // Unset the assume masterwork and lock element settings
    delete draft.assumeArmorMasterwork;
    delete draft.lockArmorEnergyType;
  });
}
