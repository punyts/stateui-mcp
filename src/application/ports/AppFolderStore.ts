/**
 * The side folder of an app part, named by the part's id: its preview error log, the metadata of its uploaded files and
 * their bytes. It outlives nothing: deleting the app removes it
 */
export interface AppFolderStore {
    /** Removes the folder with everything in it; nothing happens when there is none */
    remove(appId: string): Promise<void>;
}
