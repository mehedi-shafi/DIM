import {
  defaultLoadoutParameters,
  LoadoutParameters,
  StatConstraint,
} from '@destinyitemmanager/dim-api-types';
import {
  customStatsSelector,
  savedLoadoutParametersSelector,
  settingSelector,
} from 'app/dim-api/selectors';
import { t } from 'app/i18next-t';
import { SocketOverrides } from 'app/inventory/store/override-sockets';
import { Loadout } from 'app/loadout-drawer/loadout-types';
import { newLoadout } from 'app/loadout-drawer/loadout-utils';
import { parseLoadoutFromURLParam } from 'app/loadout-drawer/LoadoutDrawer2';
import { useD2Definitions } from 'app/manifest/selectors';
import { showNotification } from 'app/notifications/notifications';
import { DestinyClass } from 'bungie-api-ts/destiny2';
import produce from 'immer';
import { useSelector } from 'react-redux';
import { useLocation, useNavigate } from 'react-router';
import { LockableBucketHashes } from './types';

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
// TODO: filter to matching store IDs here?
export function useInitialLoadout(): [loadout: Loadout, selectedStoreId?: string | undefined] {
  const defs = useD2Definitions();
  const navigate = useNavigate();
  const { pathname, state, search } = useLocation();
  const savedLoadoutParameters = useSelector(savedLoadoutParametersSelector);
  const customStatsByClass = useSelector(customStatsSelector);
  const loStatOrderByClass = useSelector(settingSelector('loStatOrderByClass'));

  // Try getting the loadout from state (if it was linked from elsewhere, like the loadout drawer)
  if (state) {
    const { loadout, storeId } = state as {
      loadout: Loadout;
      storeId?: string;
    };
    let preloadedLoadout = loadout;
    if (preloadedLoadout) {
      // TODO: if the loadout has an exotic armor piece, should we add that to the loadout params automatically?
      if (!preloadedLoadout.parameters?.exoticArmorHash && defs) {
        const equippedExotic = preloadedLoadout.items
          .filter((li) => li.equip)
          .map((li) => defs.InventoryItem.get(li.hash))
          .find(
            (i) =>
              Boolean(i?.equippingBlock?.uniqueLabel) &&
              LockableBucketHashes.includes(i.inventory?.bucketTypeHash ?? 0)
          );

        if (equippedExotic) {
          preloadedLoadout = {
            ...preloadedLoadout,
            parameters: { ...preloadedLoadout.parameters, exoticArmorHash: equippedExotic.hash },
          };
        }
      }
      return [preloadedLoadout, storeId];
    }
  }

  // Look for a fully specified loadout in a query parameter
  const searchParams = new URLSearchParams(search);
  // This parameter isn't named "loadout" because sending that will load the loadout into the loadout drawer!
  const loadoutJSON = searchParams.get('l');
  if (loadoutJSON) {
    try {
      const parsedLoadout = parseLoadoutFromURLParam(loadoutJSON);
      if (parsedLoadout) {
        return [parsedLoadout];
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

  // If there aren't ignored/ordered stats, fill them in from defaults
  if (!loadoutParameters?.statConstraints) {
    let statConstraints: StatConstraint[] = [];
    const savedStats = loStatOrderByClass[classType];
    if (savedStats) {
      statConstraints = savedStats;
    }
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

  return [constructedLoadout];
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
