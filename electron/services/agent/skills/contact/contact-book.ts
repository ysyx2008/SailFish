/**
 * 本地联系人领域门面：秘书的 contact_* 工具和设置里的联系人页都经它读写，
 * 撞名规则只在这里判一次。
 */
import type {
  Contact,
  ContactAddResult,
  ContactCreateInput,
  ContactDeleteResult,
  ContactUpdatePatch,
  ContactUpdateResult,
} from '@sailfish/shared-types'
import {
  applyContactUpdate,
  createContact,
  findNameCollisions,
  loadStore,
  mutateStore,
  searchContacts,
} from './store'

export class ContactBook {
  list(): Contact[] {
    return loadStore().contacts
  }

  search(query: string): Contact[] {
    return searchContacts(loadStore().contacts, query)
  }

  async add(input: ContactCreateInput): Promise<ContactAddResult> {
    const name = input.name.trim()
    return mutateStore(store => {
      const collisions = findNameCollisions(store.contacts, name, input.aliases ?? [])
      if (collisions.length > 0) return { type: 'collision', collisions }
      const contact = createContact({ ...input, name })
      store.contacts.push(contact)
      return { type: 'created', contact }
    })
  }

  async update(id: string, patch: ContactUpdatePatch): Promise<ContactUpdateResult> {
    return mutateStore(store => {
      const index = store.contacts.findIndex(item => item.id === id)
      if (index < 0) return { type: 'missing' }
      const next = applyContactUpdate(store.contacts[index], patch)
      const collisions = findNameCollisions(store.contacts, next.name, next.aliases ?? [], id)
      if (collisions.length > 0) return { type: 'collision', collisions }
      store.contacts[index] = next
      return { type: 'updated', contact: next }
    })
  }

  async remove(id: string): Promise<ContactDeleteResult> {
    return mutateStore(store => {
      const index = store.contacts.findIndex(item => item.id === id)
      if (index < 0) return { type: 'missing' }
      const [contact] = store.contacts.splice(index, 1)
      return { type: 'deleted', contact }
    })
  }
}

let instance: ContactBook | null = null

export function getContactBook(): ContactBook {
  if (!instance) instance = new ContactBook()
  return instance
}
