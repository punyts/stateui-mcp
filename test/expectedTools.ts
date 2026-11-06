/**
 * The tools the server registers, in the order of the design's table (`stateui-owner-tree-and-tools.md`): build time,
 * the owner's data, run time. That is the design's 35 names less `ui_pattern_write` (owner-tree epic 3, story O3.9),
 * which ships with search epic 2 and adds itself here: 33 at the owner-tree release, 34 with `ui_patterns_search`
 * (search epic 2, story S2.5), 35 with `ui_pattern_write`
 */
export const EXPECTED_TOOLS: readonly string[] = Object.freeze([
    // Build time: catalog
    'ui_components_search',
    'ui_component_get',
    'ui_icons_list',
    'ui_tokens_list',
    'ui_patterns_search',
    // Build time: any part
    'ui_list',
    'ui_get',
    'ui_rename',
    'ui_delete',
    'ui_validate',
    // Build time: apps and screens
    'ui_app_create',
    'ui_app_configure',
    'ui_screen_create',
    'ui_nodes_write',
    'ui_locale_write',
    // Build time: themes, logic, models, composed components
    'ui_theme_create',
    'ui_theme_write',
    'ui_logic_write',
    'ui_model_write',
    'ui_composed_write',
    // The owner's data
    'ui_data_write',
    'ui_data_query',
    // Run time
    'ui_state_get',
    'ui_state_set',
    'ui_state_reset',
    'ui_preview',
    'ui_screenshot',
    'ui_interact',
    'ui_command',
    'ui_events_read',
    'ui_call_answer',
    'ui_logic_trace',
    'ui_file_read',
    'ui_tree'
]);
