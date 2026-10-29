import { CHARACTER_FIELD_KEYS, CHARACTER_FIELD_LABELS, type Character } from '../../../shared/domain'

/** F14：只读人物卡。卡片上任何操作都不修改正文（只改悬停偏好或本次会话的忽略列表）。 */
export function CharacterHoverCard({ term, characters, position, showOpenLink, onOpen, onIgnoreTerm, onIgnoreHere, onMouseEnter, onMouseLeave }: {
  term: string; characters: Character[]; position: { left: number; top: number }; showOpenLink: boolean
  onOpen(characterId: string): void; onIgnoreTerm(): void; onIgnoreHere(): void; onMouseEnter(): void; onMouseLeave(): void
}): React.JSX.Element {
  return <div className="character-hover-card" role="dialog" aria-label={`人物卡 · ${term}`} data-testid="character-hover-card"
    style={{ left: position.left, top: position.top }} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
    {characters.map((character) => {
      const fields = CHARACTER_FIELD_KEYS.filter((key) => character.fields[key]?.trim()).slice(0, 4)
      const notes = character.notes.trim()
      return <section key={character.id}>
        <header><strong>{character.name}</strong>{term !== character.name && <small>匹配别名：{term}</small>}</header>
        {notes && <p>{notes.length > 120 ? `${notes.slice(0, 120)}…` : notes}</p>}
        {fields.length > 0 && <dl>{fields.map((key) => <div key={key}><dt>{CHARACTER_FIELD_LABELS[key]}</dt><dd>{character.fields[key]}</dd></div>)}</dl>}
        {showOpenLink && <button className="link-button" onClick={() => onOpen(character.id)}>打开人物卡</button>}
      </section>
    })}
    {characters.length > 1 && <p className="hover-card-hint">同名人物 {characters.length} 张卡</p>}
    <footer><button onClick={onIgnoreTerm}>此别名不提示</button><button onClick={onIgnoreHere}>忽略此处</button></footer>
  </div>
}
