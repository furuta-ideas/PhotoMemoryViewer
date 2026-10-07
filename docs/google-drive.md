# Google Drive接続の設定

このアプリは非公開の写真を、ユーザーの許可を受けて読み取ります。GoogleアカウントのパスワードやClient Secretをアプリへ入力する必要はありません。

## 初回だけ必要なGoogle Cloud設定

1. [Google Cloud Console](https://console.cloud.google.com/)でプロジェクトを作成／選択します。
2. 「APIとサービス」から **Google Drive API** を有効にします。
3. Google Auth Platformでアプリ名、サポートメール、対象ユーザーを設定します。個人のテストではテストユーザーに自分のGoogleアカウントを追加します。
4. データアクセスに `https://www.googleapis.com/auth/drive.readonly` を追加します。
5. OAuthクライアントを **ウェブアプリケーション** として作成します。
6. 承認済みのJavaScript生成元に、アプリを開く生成元を追加します。ローカルの既定値は `http://localhost:5502`。本番は `https://your-domain.example` のようなURLです。パスは含めません。
7. 発行された `…apps.googleusercontent.com` のクライアントIDを、アプリの「Google接続の初期設定」へ入力します。

## アプリでの接続

1. Google Driveに、日付付きフォルダをまとめた親フォルダを用意します。
2. 親フォルダのURLをコピーし、アプリの「フォルダURL / ID」へ貼り付けます。
3. 「Googleに接続して読み込む」を押します。初回の外部ライブラリ準備後は、案内に従ってもう一度押します。
4. Googleの認証画面で、対象アカウントと読み取り権限を許可します。
5. 読み込み完了後、Playを押します。

既存フォルダ配下を再帰的に探索するため、任意のDriveファイルを読み取り可能な `drive.readonly` を使います。アプリは指定フォルダ以下のみ取得し、変更・削除は行いません。限定的な `drive.file` だけで任意の既存フォルダの全ファイルを読めるとは扱っていません。

アクセストークンはメモリ内だけに保持し、localStorageやGitHubに保存しません。長時間の再生で認証が切れた場合は、写真を保持したまま停止し、再接続を案内します。「接続解除」で有効なトークンの認可を取り消します。トークン失効後はGoogleアカウントの接続済みアプリ画面からも解除できます。

本番公開でこの権限を使う場合、GoogleのOAuth審査やプライバシーポリシー等が必要になる場合があります。設定画面の注意表示を読み、公開形態に合わせてGoogleの要件を確認してください。

共有ドライブ、Googleフォルダショートカット、Googleフォトは初期版の対象外です。

## iPad / iPhone

SafariでHTTPS配信されたアプリを開きます。PCで動かしているlocalhostはiPhone自身のlocalhostとは異なるため、PCのURLをそのまま入力して利用することはできません。静的ホスティング先と同じ生成元をGoogleの承認済み生成元へ登録してください。

## 参照

- [Google Identity Services token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model)
- [Drive API files.list](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list)
- [Drive API OAuth scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)

## アルバムの親フォルダを選択する

「B.01 じいじの思い出アルバム」の下に「20050330 春の家族のお出かけ」などの日付付きフォルダ、その下に写真がある構成に対応します。

Google Driveタブで親フォルダ名を入力し、「Googleに接続して親フォルダを探す」を押します。結果の親フォルダを選ぶと配下を再帰的に読み込み、各写真の日付・表示名は所属する日付付きフォルダから取得します。親フォルダに日付は不要です。名前の先頭部分でも検索できます。同名の候補はフォルダIDで区別できます。初回のOAuth設定は必要です。

iPadの「ファイル」アプリ内にあるDriveからのフォルダ選択と、このGoogle Drive接続は別の方法です。通常の写真ファイル選択からは親フォルダの階層を取得できないため、アルバム全体にはGoogle Drive接続を使います。Windowsでは「この端末」から親フォルダを選択する方法にも対応します。
