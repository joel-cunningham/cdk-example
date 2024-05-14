# update packages
sudo yum update -y
# install nodejs
#curl -fsSL https://rpm.nodesource.com/setup_16.x | sudo bash -
sudo yum update -y
touch ~/.bash_profile
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.5/install.sh | bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
#sudo yum install -y nodejs18
nvm install 16
node -v
npm -v
npm install pm2 -g
