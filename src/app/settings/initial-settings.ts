import { defaultSettings, Settings as DimApiSettings } from '@destinyitemmanager/dim-api-types';
import { defaultLanguage } from 'app/i18n';
import { ArmorStatHashes } from 'app/loadout-builder/types';

export const enum LoadoutSort {
  ByEditTime,
  ByName,
}

/**
 * We extend the settings interface so we can try out new settings before committing them to dim-api-types
 */
export interface Settings extends DimApiSettings {
  /** Display perks as a list instead of a grid. */
  perkList: boolean;
  loadoutSort: LoadoutSort;
  itemFeedHideTagged: boolean;
  itemFeedExpanded: boolean;
  /** Pull from postmaster is an irreversible action and some people don't want to accidentally hit it. */
  hidePullFromPostmaster: boolean;
  readonly loStatOrderByClass: {
    [key: number]: ArmorStatHashes[];
  };
}

export const initialSettingsState: Settings = {
  ...defaultSettings,
  language: defaultLanguage(),
  perkList: true,
  loadoutSort: LoadoutSort.ByEditTime,
  itemFeedHideTagged: true,
  itemFeedExpanded: false,
  hidePullFromPostmaster: false,
  loStatOrderByClass: {},
};
