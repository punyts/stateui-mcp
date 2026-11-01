/**
 * The stored expectation of the outline of `SAMPLE_FORM_AND_LIST_APP` (E6.7): the resolved document without a
 * snapshot, in the base language. `toastRegion` is the default `toasts` slot of `page`
 */
export const SAMPLE_FORM_AND_LIST_OUTLINE: string = [
    'page "Customers"',
    '  toastRegion toasts "Notifications"',
    '  panel main "Customer list"',
    '    form',
    '      textField name "Name"',
    '      selectField status "Status"',
    '    list customers <-$.data.customers',
    '      text row <-$row.name (2 records)',
    '  modal confirm "Discard changes?" (closed)',
    '  toolbar footer [button save "Save"]'
].join('\n');
